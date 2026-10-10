//! REA Cloud storage core (experimental).
//!
//! This crate stores opaque, already-encrypted REAC1 envelopes. It never receives
//! user encryption keys and never executes content supplied by peers. Its quota
//! is an application-level payload quota, not an operating-system disk quota.

use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAGIC: &[u8; 5] = b"REAC1";
const MIN_ENVELOPE_BYTES: usize = 33;

#[derive(Debug, PartialEq, Eq)]
pub enum StorageError {
    InvalidConfiguration,
    InvalidChunkId,
    InvalidEnvelope,
    DigestMismatch,
    CapacityExhausted { available_bytes: u64 },
    LockTimeout,
    UnsafePath,
    Io(String),
}

impl From<std::io::Error> for StorageError {
    fn from(value: std::io::Error) -> Self { Self::Io(value.to_string()) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutReceipt {
    pub chunk_id: String,
    pub bytes: u64,
    pub already_present: bool,
}

/// Opaque encrypted block store with bounded payload quota.
///
/// Separate processes sharing a root coordinate through an atomic lock directory.
/// For strong protection against unrelated/malicious local processes, place this
/// directory on a dedicated filesystem with an OS-enforced quota as well.
pub struct StorageCore {
    root: PathBuf,
    max_chunk_bytes: u64,
    max_storage_bytes: u64,
    lock_wait: Duration,
}

impl StorageCore {
    pub fn new(root: impl AsRef<Path>, max_chunk_bytes: u64, max_storage_bytes: u64) -> Result<Self, StorageError> {
        if max_chunk_bytes < MIN_ENVELOPE_BYTES as u64 || max_storage_bytes < max_chunk_bytes {
            return Err(StorageError::InvalidConfiguration);
        }
        Ok(Self { root: root.as_ref().to_path_buf(), max_chunk_bytes, max_storage_bytes, lock_wait: Duration::from_secs(5) })
    }

    pub fn init(&self) -> Result<(), StorageError> {
        fs::create_dir_all(&self.root)?;
        let metadata = fs::symlink_metadata(&self.root)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err(StorageError::UnsafePath); }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    pub fn put(&self, chunk_id: &str, envelope: &[u8]) -> Result<PutReceipt, StorageError> {
        if !valid_digest(chunk_id) { return Err(StorageError::InvalidChunkId); }
        if envelope.len() < MIN_ENVELOPE_BYTES || envelope.len() as u64 > self.max_chunk_bytes || !envelope.starts_with(MAGIC) {
            return Err(StorageError::InvalidEnvelope);
        }
        if hex(&Sha256::digest(envelope)) != chunk_id { return Err(StorageError::DigestMismatch); }
        self.with_lock(|| self.put_locked(chunk_id, envelope))
    }

    pub fn get(&self, chunk_id: &str) -> Result<Vec<u8>, StorageError> {
        if !valid_digest(chunk_id) { return Err(StorageError::InvalidChunkId); }
        let path = self.chunk_path(chunk_id);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() < MIN_ENVELOPE_BYTES as u64 || metadata.len() > self.max_chunk_bytes {
            return Err(StorageError::UnsafePath);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(path)?.read_to_end(&mut bytes)?;
        if !bytes.starts_with(MAGIC) || hex(&Sha256::digest(&bytes)) != chunk_id { return Err(StorageError::DigestMismatch); }
        Ok(bytes)
    }

    pub fn used_bytes(&self) -> Result<u64, StorageError> { self.scan_bytes() }
    pub fn quota_bytes(&self) -> u64 { self.max_storage_bytes }

    fn put_locked(&self, chunk_id: &str, envelope: &[u8]) -> Result<PutReceipt, StorageError> {
        let target = self.chunk_path(chunk_id);
        let parent = target.parent().ok_or(StorageError::UnsafePath)?;
        fs::create_dir_all(parent)?;
        let parent_meta = fs::symlink_metadata(parent)?;
        if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() { return Err(StorageError::UnsafePath); }

        match self.get(chunk_id) {
            Ok(existing) if existing == envelope => return Ok(PutReceipt { chunk_id: chunk_id.into(), bytes: envelope.len() as u64, already_present: true }),
            Ok(_) => return Err(StorageError::DigestMismatch),
            Err(StorageError::Io(ref message)) if message.contains("No such file") || message.contains("not found") => {},
            Err(StorageError::Io(_)) => {
                if !target.exists() { /* first write */ } else { return Err(StorageError::UnsafePath); }
            }
            Err(_) if !target.exists() => {},
            Err(error) => return Err(error),
        }

        let used = self.scan_bytes()?;
        let size = envelope.len() as u64;
        if used.saturating_add(size) > self.max_storage_bytes {
            return Err(StorageError::CapacityExhausted { available_bytes: self.max_storage_bytes.saturating_sub(used) });
        }
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let temp = parent.join(format!(".tmp-{}-{nonce}", std::process::id()));
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        let write_result = (|| -> Result<(), StorageError> { file.write_all(envelope)?; file.sync_all()?; Ok(()) })();
        drop(file);
        if let Err(error) = write_result { let _ = fs::remove_file(&temp); return Err(error); }
        let result = match fs::hard_link(&temp, &target) {
            Ok(()) => Ok(PutReceipt { chunk_id: chunk_id.into(), bytes: size, already_present: false }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = self.get(chunk_id)?;
                if existing == envelope { Ok(PutReceipt { chunk_id: chunk_id.into(), bytes: size, already_present: true }) } else { Err(StorageError::DigestMismatch) }
            }
            Err(error) => Err(StorageError::Io(error.to_string())),
        };
        let _ = fs::remove_file(temp);
        result
    }

    fn scan_bytes(&self) -> Result<u64, StorageError> {
        let mut total = 0u64;
        if !self.root.exists() { return Ok(0); }
        for shard in fs::read_dir(&self.root)? {
            let shard = shard?;
            let name = shard.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') { continue; }
            let meta = fs::symlink_metadata(shard.path())?;
            if !meta.is_dir() || meta.file_type().is_symlink() || name.len() != 2 || !name.bytes().all(is_hex) { return Err(StorageError::UnsafePath); }
            for entry in fs::read_dir(shard.path())? {
                let entry = entry?;
                let file_name = entry.file_name().to_string_lossy().into_owned();
                let file_meta = fs::symlink_metadata(entry.path())?;
                if file_name.starts_with(".tmp-") { continue; }
                if file_name.len() != 62 || !file_name.bytes().all(is_hex) || !file_meta.is_file() || file_meta.file_type().is_symlink() {
                    return Err(StorageError::UnsafePath);
                }
                total = total.checked_add(file_meta.len()).ok_or(StorageError::InvalidConfiguration)?;
            }
        }
        Ok(total)
    }

    fn chunk_path(&self, id: &str) -> PathBuf { self.root.join(&id[..2]).join(&id[2..]) }

    fn with_lock<T>(&self, operation: impl FnOnce() -> Result<T, StorageError>) -> Result<T, StorageError> {
        let lock = self.root.join(".rea-rust-storage-lock");
        let started = Instant::now();
        loop {
            match fs::create_dir(&lock) {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if started.elapsed() >= self.lock_wait { return Err(StorageError::LockTimeout); }
                    thread::sleep(Duration::from_millis(15));
                }
                Err(error) => return Err(StorageError::Io(error.to_string())),
            }
        }
        let result = operation();
        // Only remove a real directory; never follow a symlink during cleanup.
        if fs::symlink_metadata(&lock).map(|m| m.is_dir() && !m.file_type().is_symlink()).unwrap_or(false) {
            let _ = fs::remove_dir(lock);
        }
        result
    }
}

fn valid_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(is_hex) }
fn is_hex(byte: u8) -> bool { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
fn hex(bytes: &[u8]) -> String { const TABLE: &[u8; 16] = b"0123456789abcdef"; let mut out = String::with_capacity(bytes.len() * 2); for b in bytes { out.push(TABLE[(b >> 4) as usize] as char); out.push(TABLE[(b & 0x0f) as usize] as char); } out }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("rea-rust-core-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
    }
    fn envelope(fill: u8) -> Vec<u8> { let mut value = b"REAC1".to_vec(); value.extend(std::iter::repeat(fill).take(64)); value }
    fn id(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }

    #[test]
    fn stores_and_reads_verified_envelope() {
        let root = temp_root(); let store = StorageCore::new(&root, 1024, 2048).unwrap(); store.init().unwrap();
        let bytes = envelope(7); let digest = id(&bytes);
        let receipt = store.put(&digest, &bytes).unwrap();
        assert!(!receipt.already_present); assert_eq!(store.get(&digest).unwrap(), bytes); assert_eq!(store.used_bytes().unwrap(), bytes.len() as u64);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_quota_overflow() {
        let root = temp_root(); let bytes = envelope(8); let store = StorageCore::new(&root, 1024, bytes.len() as u64).unwrap(); store.init().unwrap();
        store.put(&id(&bytes), &bytes).unwrap();
        let other = envelope(9);
        assert!(matches!(store.put(&id(&other), &other), Err(StorageError::CapacityExhausted { .. })));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_wrong_digest_and_non_encrypted_envelope() {
        let root = temp_root(); let store = StorageCore::new(&root, 1024, 2048).unwrap(); store.init().unwrap();
        let bytes = envelope(10);
        assert_eq!(store.put(&"0".repeat(64), &bytes), Err(StorageError::DigestMismatch));
        assert_eq!(store.put(&id(&bytes), b"plaintext-not-an-envelope"), Err(StorageError::InvalidEnvelope));
        let _ = fs::remove_dir_all(root);
    }
}
