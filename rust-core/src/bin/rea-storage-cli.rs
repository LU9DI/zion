use rea_storage_core::{StorageCore, StorageError};
use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;

fn usage() -> ! {
    eprintln!("usage: rea-storage-cli <init|put|get|usage> <root> <max_chunk_bytes> <max_storage_bytes> [chunk_id]");
    std::process::exit(64);
}

fn number(value: Option<String>) -> u64 {
    value.and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).unwrap_or_else(|| usage())
}

fn emit_error(error: StorageError) -> ! {
    match error {
        StorageError::CapacityExhausted { available_bytes } => eprintln!("ERR CAPACITY_EXHAUSTED {available_bytes}"),
        StorageError::InvalidChunkId => eprintln!("ERR INVALID_CHUNK_ID"),
        StorageError::InvalidEnvelope => eprintln!("ERR INVALID_ENVELOPE"),
        StorageError::DigestMismatch => eprintln!("ERR DIGEST_MISMATCH"),
        StorageError::LockTimeout => eprintln!("ERR LOCK_TIMEOUT"),
        StorageError::UnsafePath => eprintln!("ERR UNSAFE_PATH"),
        StorageError::InvalidConfiguration => eprintln!("ERR INVALID_CONFIGURATION"),
        StorageError::Io(_) => eprintln!("ERR STORAGE_IO"),
    }
    std::process::exit(2)
}

fn main() {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| usage());
    let root = PathBuf::from(args.next().unwrap_or_else(|| usage()));
    let max_chunk = number(args.next());
    let max_storage = number(args.next());
    let chunk_id = args.next();
    if args.next().is_some() { usage(); }

    let store = StorageCore::new(root, max_chunk, max_storage).unwrap_or_else(|e| emit_error(e));
    if command == "init" {
        store.init().unwrap_or_else(|e| emit_error(e));
        println!("OK");
    } else if command == "put" {
        let id = chunk_id.unwrap_or_else(|| usage());
        let mut bytes = Vec::new();
        io::stdin().take(max_chunk.saturating_add(1)).read_to_end(&mut bytes).unwrap_or_else(|_| emit_error(StorageError::Io("stdin".into())));
        if bytes.len() as u64 > max_chunk { emit_error(StorageError::InvalidEnvelope); }
        let receipt = store.put(&id, &bytes).unwrap_or_else(|e| emit_error(e));
        println!("OK {} {}", receipt.bytes, if receipt.already_present { 1 } else { 0 });
    } else if command == "get" {
        let id = chunk_id.unwrap_or_else(|| usage());
        let bytes = store.get(&id).unwrap_or_else(|e| emit_error(e));
        io::stdout().write_all(&bytes).unwrap_or_else(|_| emit_error(StorageError::Io("stdout".into())));
    } else if command == "usage" {
        println!("{}", store.used_bytes().unwrap_or_else(|e| emit_error(e)));
    } else {
        usage();
    }
}
