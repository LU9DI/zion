import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
const VERSION = 1;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const payloadFor = state => JSON.stringify({ version: VERSION, state });
const emptyState = () => ({ pending: [], consumed: [] });

/** Atomic, fsync-backed snapshots for a single local auditor process. */
export class FileStorageAuditStateStore {
  constructor(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (typeof path !== 'string' || !path.trim() || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new TypeError('Invalid audit state store configuration');
    this.path = resolve(path);
    this.maxBytes = maxBytes;
  }
  load() {
    if (!existsSync(this.path)) return emptyState();
    const bytes = readFileSync(this.path);
    if (bytes.length > this.maxBytes) throw Object.assign(new Error('Audit state snapshot exceeds configured limit'), { code: 'ZION_AUDIT_STATE_TOO_LARGE' });
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw Object.assign(new Error('Audit state snapshot is not valid JSON'), { code: 'ZION_AUDIT_STATE_CORRUPT' }); }
    if (!parsed || parsed.version !== VERSION || !parsed.state || !Array.isArray(parsed.state.pending) || !Array.isArray(parsed.state.consumed) ||
        typeof parsed.checksum !== 'string' || hash(payloadFor(parsed.state)) !== parsed.checksum) {
      throw Object.assign(new Error('Audit state snapshot failed integrity validation'), { code: 'ZION_AUDIT_STATE_CORRUPT' });
    }
    return { pending: parsed.state.pending, consumed: parsed.state.consumed };
  }
  save(state) {
    if (!state || !Array.isArray(state.pending) || !Array.isArray(state.consumed)) throw new TypeError('Invalid audit state');
    const bytes = Buffer.from(JSON.stringify({ version: VERSION, state, checksum: hash(payloadFor(state)) }) + '\n');
    if (bytes.length > this.maxBytes) throw Object.assign(new Error('Audit state snapshot exceeds configured limit'), { code: 'ZION_AUDIT_STATE_TOO_LARGE' });
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = resolve(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, this.path);
      // Node.js cannot portably fsync directory handles on Windows (EPERM).
      // The snapshot file itself is fsynced; Windows directory-entry durability is weaker.
      if (process.platform !== 'win32') {
        const dirFd = openSync(dir, 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}
