import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const payloadFor = state => JSON.stringify({ version: VERSION, state });
const emptyState = () => ({ version: 1, consumed: [], admissions: [] });

function validState(state) {
  return Boolean(state && state.version === 1 &&
    Array.isArray(state.consumed) && state.consumed.length <= MAX_RECORDS &&
    state.consumed.every(x => typeof x === 'string' && x.length > 0 && x.length <= 129) &&
    Array.isArray(state.admissions) && state.admissions.length <= MAX_RECORDS &&
    state.admissions.every(x => x && typeof x.subjectNodeId === 'string' &&
      /^[a-f0-9]{64}$/.test(x.subjectNodeId) && Array.isArray(x.issuerNodeIds) &&
      x.issuerNodeIds.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))));
}

/**
 * Durable, atomic local snapshots for PeerAdmissionController.
 * This store is for one coordinating process only; atomic rename is not a cross-process transaction.
 * SHA-256 detects accidental corruption, not hostile edits or rollback.
 */
export class FilePeerAdmissionStateStore {
  constructor(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    if (typeof path !== 'string' || !path.trim() ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) {
      throw new TypeError('Invalid peer admission state store configuration');
    }
    this.path = resolve(path);
    this.maxBytes = maxBytes;
  }

  load() {
    if (!existsSync(this.path)) return emptyState();
    const bytes = readFileSync(this.path);
    if (bytes.length > this.maxBytes) {
      throw Object.assign(new Error('Peer admission snapshot exceeds configured limit'), { code: 'ZION_ADMISSION_STATE_TOO_LARGE' });
    }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch {
      throw Object.assign(new Error('Peer admission snapshot is not valid JSON'), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
    }
    if (!parsed || parsed.version !== VERSION || !validState(parsed.state) ||
      typeof parsed.checksum !== 'string' || hash(payloadFor(parsed.state)) !== parsed.checksum) {
      throw Object.assign(new Error('Peer admission snapshot failed integrity validation'), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
    }
    return {
      version: 1,
      consumed: [...parsed.state.consumed],
      admissions: parsed.state.admissions.map(x => ({
        subjectNodeId: x.subjectNodeId, issuerNodeIds: [...x.issuerNodeIds],
      })),
    };
  }

  save(state) {
    if (!validState(state)) throw new TypeError('Invalid peer admission state');
    const normalized = {
      version: 1,
      consumed: [...state.consumed],
      admissions: state.admissions.map(x => ({
        subjectNodeId: x.subjectNodeId, issuerNodeIds: [...x.issuerNodeIds],
      })),
    };
    const bytes = Buffer.from(JSON.stringify({
      version: VERSION, state: normalized, checksum: hash(payloadFor(normalized)),
    }) + '\n');
    if (bytes.length > this.maxBytes) {
      throw Object.assign(new Error('Peer admission snapshot exceeds configured limit'), { code: 'ZION_ADMISSION_STATE_TOO_LARGE' });
    }
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
      const dirFd = openSync(dir, 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}
