import { randomUUID } from 'node:crypto';
import { constants as fsConstants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NotificationRecoveryAuditAnchor } from './notification-recovery-audit-anchor.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

/**
 * Durable file-backed checkpoint adapter. This is suitable only when the configured directory
 * is administered independently from the registry host/storage; placing it beside the registry
 * does not create an independent trust domain. Existing lock files are never stolen automatically.
 */
export class PersistentFileNotificationAnchorAdapter {
  constructor({ anchorPath, lockTimeoutMs = 2000, retryIntervalMs = 20, _fsyncSync = fsyncSync, _unlinkSync = unlinkSync } = {}) {
    if (typeof anchorPath !== 'string' || !anchorPath.trim()) throw new TypeError('anchorPath is required');
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) throw new TypeError('lockTimeoutMs must be a non-negative safe integer');
    if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1) throw new TypeError('retryIntervalMs must be a positive safe integer');
    this.anchorPath = resolve(anchorPath);
    this.lockPath = `${this.anchorPath}.lock`;
    this.lockTimeoutMs = lockTimeoutMs;
    this.retryIntervalMs = retryIntervalMs;
    if (typeof _fsyncSync !== 'function') throw new TypeError('_fsyncSync must be a function');
    // Private test seam for deterministic durability-failure tests; production callers should omit it.
    this._fsyncSync = _fsyncSync;
    if (typeof _unlinkSync !== 'function') throw new TypeError('_unlinkSync must be a function');
    this._unlinkSync = _unlinkSync;
  }

  async getLatest() {
    let fd;
    let raw;
    try {
      // O_NOFOLLOW closes the symlink check/read race on platforms that support it.
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      fd = openSync(this.anchorPath, flags);
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw fail('NOTIFICATION_ANCHOR_UNSAFE_FILE', 'Anchor must be a regular non-symlink file');
      raw = readFileSync(fd, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'ELOOP') throw fail('NOTIFICATION_ANCHOR_UNSAFE_FILE', 'Anchor must be a regular non-symlink file');
      if (error.code === 'NOTIFICATION_ANCHOR_UNSAFE_FILE') throw error;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) { throw fail('NOTIFICATION_ANCHOR_CORRUPT', `Cannot parse anchor checkpoint: ${error.message}`); }
    if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(value)) throw fail('NOTIFICATION_ANCHOR_CORRUPT', 'Stored checkpoint shape is invalid');
    return structuredClone(value);
  }

  async publish(checkpoint) {
    if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(checkpoint)) throw fail('NOTIFICATION_ANCHOR_INVALID_CHECKPOINT', 'Checkpoint shape is invalid');
    const lock = await this.#acquireLock();
    let result;
    let operationError;
    try {
      const current = await this.getLatest();
      if (current) {
        const currentHash = NotificationRecoveryAuditAnchor.checkpointSha256(current);
        const incomingHash = NotificationRecoveryAuditAnchor.checkpointSha256(checkpoint);
        if (currentHash === incomingHash) {
          try { this.#confirmDurability(); }
          catch (error) { throw fail('NOTIFICATION_ANCHOR_DURABILITY_UNCONFIRMED', `Checkpoint is visible but durability is unconfirmed: ${error.message}`); }
          result = { stored: true, idempotent: true };
        } else {
          const comparison = NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: current, observed: checkpoint });
          if (!comparison.consistent || comparison.code !== 'advanced') throw fail('NOTIFICATION_ANCHOR_CONFLICT', `Cannot replace checkpoint: ${comparison.code}`);
        }
      } else if (checkpoint.previousCheckpointSha256 !== null) {
        throw fail('NOTIFICATION_ANCHOR_MISSING_ANCESTRY', 'First stored checkpoint cannot reference an unavailable predecessor');
      }

      if (!result) {
      const directory = dirname(this.anchorPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.anchorPath}.tmp-${process.pid}-${randomUUID()}`;
      let fd;
      try {
        fd = openSync(temporaryPath, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(checkpoint)}\n`, 'utf8');
        this._fsyncSync(fd);
        closeSync(fd); fd = undefined;
        renameSync(temporaryPath, this.anchorPath);
        // Windows does not support portable directory-handle fsync in Node.js (EPERM).
        // The checkpoint file itself is fsynced; Windows directory-entry durability is weaker.
        if (process.platform !== 'win32') {
          const dirFd = openSync(directory, 'r');
          try { this._fsyncSync(dirFd); } finally { closeSync(dirFd); }
        }
      } catch (error) {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        try { unlinkSync(temporaryPath); } catch {}
        throw fail('NOTIFICATION_ANCHOR_DURABILITY_UNCONFIRMED', `Checkpoint publication durability is unconfirmed: ${error.message}`);
      }
      result = { stored: true, idempotent: false };
      }
    } catch (error) {
      operationError = error;
    }
    let releaseError;
    try {
      // Do not remove a lock that has been replaced by an operator or another process.
      const currentLockStat = lstatSync(lock.path);
      const currentLock = JSON.parse(readFileSync(lock.path, 'utf8'));
      if (currentLock.token !== lock.token || currentLockStat.dev !== lock.dev || currentLockStat.ino !== lock.ino) {
        throw fail('NOTIFICATION_ANCHOR_LOCK_OWNERSHIP_LOST', 'Anchor lock no longer matches the lock acquired by this publisher; leaving it untouched');
      }
      this._unlinkSync(lock.path);
    } catch (error) {
      if (error.code !== 'ENOENT') releaseError = error.code === 'NOTIFICATION_ANCHOR_LOCK_OWNERSHIP_LOST' ? error : fail('NOTIFICATION_ANCHOR_LOCK_RELEASE_FAILED', `Could not release anchor lock: ${error.message}`);
    }
    if (operationError && releaseError) throw new AggregateError([operationError, releaseError], 'Anchor operation failed and its lock could not be released', { cause: operationError });
    if (operationError) throw operationError;
    if (releaseError) throw releaseError;
    return result;
  }

  #confirmDurability() {
    const directory = dirname(this.anchorPath);
    let fileFd;
    try {
      fileFd = openSync(this.anchorPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      if (!fstatSync(fileFd).isFile()) throw fail('NOTIFICATION_ANCHOR_UNSAFE_FILE', 'Anchor must be a regular non-symlink file');
      this._fsyncSync(fileFd);
    } finally {
      if (fileFd !== undefined) closeSync(fileFd);
    }
    // The checkpoint file is fsynced above. Directory-entry durability is weaker on Windows.
    if (process.platform !== 'win32') {
      const dirFd = openSync(directory, 'r');
      try { this._fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  }

  async #acquireLock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        const token = randomUUID();
        const fd = openSync(this.lockPath, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), token })); this._fsyncSync(fd); }
        catch (error) { closeSync(fd); throw error; }
        const stat = fstatSync(fd);
        closeSync(fd);
        return { path: this.lockPath, token, dev: stat.dev, ino: stat.ino };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw fail('NOTIFICATION_ANCHOR_LOCK_TIMEOUT', 'Anchor is locked; lock is not stolen automatically');
        await sleep(Math.min(this.retryIntervalMs, Math.max(1, deadline - Date.now())));
      }
    }
  }
}
