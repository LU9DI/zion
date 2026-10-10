import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Local durable owner-pause state. A corrupt/unreadable state fails closed. */
export class PauseStateStore {
  constructor({ filePath } = {}) {
    if (typeof filePath !== 'string' || filePath.trim() === '') throw new TypeError('A pause state filePath is required');
    this.filePath = resolve(filePath);
  }

  load() {
    let stat;
    try {
      stat = lstatSync(this.filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ paused: false, reason: null });
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Pause state must be a regular, non-symlink file');
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.paused !== 'boolean' ||
      (parsed.reason !== null && (typeof parsed.reason !== 'string' || parsed.reason.length < 1 || parsed.reason.length > 128)) ||
      !Number.isSafeInteger(parsed.updatedAt) || parsed.updatedAt < 0) {
      throw new Error('Invalid persisted pause state');
    }
    if (parsed.paused && !parsed.reason) throw new Error('Paused state must include a reason');
    return Object.freeze({ paused: parsed.paused, reason: parsed.reason });
  }

  savePaused(reason) {
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 128) throw new TypeError('Invalid pause reason');
    this.#write({ version: 1, paused: true, reason, updatedAt: Date.now() });
  }

  clear() {
    try {
      const stat = lstatSync(this.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Pause state must be a regular, non-symlink file');
      unlinkSync(this.filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  #write(value) {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(tempPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
      // Flush the file before atomic replacement; directory fsync is platform-dependent.
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempPath, this.filePath);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(tempPath); } catch {}
      throw error;
    }
  }
}

