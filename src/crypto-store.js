import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, chmod, readdir, readFile, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const digest = data => createHash('sha256').update(data).digest('hex');
const MAGIC = Buffer.from('REAC1');
const ENVELOPE_OVERHEAD = MAGIC.length + 12 + 16;
const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 1024 * 1024 * 1024;

export class EncryptedChunkStore {
  constructor(root, key, { maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES, maxStorageBytes = DEFAULT_MAX_STORAGE_BYTES } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('Encryption key must be exactly 32 bytes');
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > 64 * 1024 * 1024) {
      throw new RangeError('maxChunkBytes must be an integer from 1 to 64 MiB');
    }
    if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < maxChunkBytes + ENVELOPE_OVERHEAD) {
      throw new RangeError('maxStorageBytes must fit at least one maximum-size chunk');
    }
    this.root = path.resolve(root);
    this.key = Buffer.from(key);
    this.maxChunkBytes = maxChunkBytes;
    this.maxStorageBytes = maxStorageBytes;
    this.writeQueue = Promise.resolve();
    this.lockPath = path.join(this.root, '.rea-write-lock');
    this.lockWaitMs = 5000;
    this.lockStaleMs = 30000;
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Storage root must be a real directory, not a symlink');
    }
    // Tighten permissions for an existing directory too (best effort on platforms
    // whose filesystem does not implement POSIX mode bits).
    try { await chmod(this.root, 0o700); } catch (error) {
      if (!['ENOSYS', 'ENOTSUP', 'EPERM', 'EINVAL'].includes(error.code)) throw error;
    }
  }

  async #ensureRealDirectory(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Storage path contains a non-directory or symbolic link');
    }
  }

  async #readRegularFile(filePath) {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Stored chunk path is not a regular file');
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  chunkPath(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid chunk id');
    return path.join(this.root, id.slice(0, 2), id.slice(2));
  }

  async put(plaintext) {
    const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
    if (input.length > this.maxChunkBytes) throw new RangeError('Chunk exceeds owner-configured maximum chunk size');
    // Serialize quota checks and writes so concurrent calls cannot exceed the local quota.
    const operation = this.writeQueue.then(() => this.#withProcessLock(() => this.#putWithinQuota(input)));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async #withProcessLock(operation) {
    const started = Date.now();
    const token = randomBytes(16).toString('hex');
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        try {
          const owner = { pid: process.pid, token, createdAt: Date.now() };
          const ownerPath = path.join(this.lockPath, 'owner.json');
          const handle = await open(ownerPath, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
          finally { await handle.close(); }
        } catch (error) {
          await rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.#reapDeadLockIfSafe();
        if (Date.now() - started >= this.lockWaitMs) {
          const timeout = new Error('Timed out waiting for the storage writer lock; refusing an unsafe concurrent write');
          timeout.code = 'REA_LOCK_TIMEOUT';
          throw timeout;
        }
        await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
      }
    }

    try { return await operation(); }
    finally {
      // Only the process holding this exact token may release the lock.
      try {
        const owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8'));
        if (owner.pid === process.pid && owner.token === token) {
          await rm(this.lockPath, { recursive: true, force: true });
        }
      } catch { /* fail closed: an orphaned lock is safer than deleting another writer's lock */ }
    }
  }

  async #reapDeadLockIfSafe() {
    let info;
    let owner;
    try {
      info = await lstat(this.lockPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Storage writer lock is not a real directory');
      owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // A crash between creating the lock directory and writing owner.json is
      // recoverable only after a conservative grace period.
      if (Date.now() - (info?.mtimeMs ?? Date.now()) < this.lockStaleMs) return;
      owner = null;
    }

    if (owner) {
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' ||
          !Number.isFinite(owner.createdAt) || Date.now() - owner.createdAt < this.lockStaleMs) return;
      try { process.kill(owner.pid, 0); return; }
      catch (error) { if (error.code !== 'ESRCH') return; }
    }

    // Rename is atomic: only one contender can move a stale lock directory.
    const quarantine = `${this.lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await rename(this.lockPath, quarantine);
      await rm(quarantine, { recursive: true, force: true });
    } catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
  }

  async #putWithinQuota(input) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    const envelope = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
    const id = digest(envelope);
    const target = this.chunkPath(id);
    await this.#ensureRealDirectory(path.dirname(target));
    try {
      const existingStat = await lstat(target);
      if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size > this.maxChunkBytes + ENVELOPE_OVERHEAD) {
        throw new Error('Existing chunk path is not a valid bounded file');
      }
      const existing = await this.#readRegularFile(target);
      if (digest(existing) !== id) throw new Error('Existing chunk failed content-address integrity check');
      return Object.freeze({ id, bytes: envelope.length, plaintextBytes: input.length, alreadyPresent: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const currentBytes = await this.sizeBytes();
    if (currentBytes + envelope.length > this.maxStorageBytes) {
      throw new RangeError('Owner-configured storage quota would be exceeded');
    }
    // Write and fsync a private temporary file, then hard-link it into place.
    // The final link is atomic and never overwrites an existing content address.
    const tempPath = path.join(path.dirname(target), `.tmp-${process.pid}-${randomBytes(12).toString('hex')}`);
    let handle;
    try {
      handle = await open(tempPath, 'wx', 0o600);
      await handle.writeFile(envelope);
      await handle.sync();
      await handle.close(); handle = undefined;
      try { await link(tempPath, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await this.#readRegularFile(target);
        if (digest(existing) !== id) throw new Error('Existing chunk failed content-address integrity check');
        return Object.freeze({ id, bytes: envelope.length, plaintextBytes: input.length, alreadyPresent: true });
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(tempPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return Object.freeze({ id, bytes: envelope.length, plaintextBytes: input.length, alreadyPresent: false });
  }

  async get(id) {
    const envelope = await this.#readRegularFile(this.chunkPath(id));
    if (envelope.length > this.maxChunkBytes + ENVELOPE_OVERHEAD) throw new Error('Stored chunk exceeds configured maximum size');
    if (digest(envelope) !== id) throw new Error('Chunk integrity check failed');
    if (envelope.length < ENVELOPE_OVERHEAD || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid chunk envelope');
    const nonce = envelope.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = envelope.subarray(MAGIC.length + 12, ENVELOPE_OVERHEAD);
    const ciphertext = envelope.subarray(ENVELOPE_OVERHEAD);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  async remove(id) { await unlink(this.chunkPath(id)); }

  async sizeBytes() {
    let total = 0;
    const walk = async dir => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (dir === this.root && entry.name === '.rea-write-lock') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Symbolic links are not allowed inside the storage directory');
        if (entry.isDirectory()) await walk(fullPath);
        else if (entry.isFile()) total += (await lstat(fullPath)).size;
      }
    };
    await walk(this.root);
    return total;
  }
}
