import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const DOMAIN = 'ZION-COMMITTED-BLOCK-JOURNAL-V1\0';
const ZERO_HASH = '0'.repeat(64);

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Journal values must use safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => key !== 'length' &&
      (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError('Journal arrays must not contain extra properties');
    }
    const items = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Journal arrays must be dense data arrays');
      }
      items.push(canonical(descriptor.value));
    }
    return '[' + items.join(',') + ']';
  }
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) {
      throw new TypeError('Journal objects must not contain symbol keys');
    }
    return '{' + Object.keys(descriptors).sort().map(key => {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Journal objects must contain enumerable data properties only');
      }
      return JSON.stringify(key) + ':' + canonical(descriptor.value);
    }).join(',') + '}';
  }
  throw new TypeError('Journal values must be canonical JSON');
}

const digestWithDomain = (domain, value) => createHash('sha256').update(domain).update(canonical(value)).digest('hex');
const digest = value => digestWithDomain(DOMAIN, value);
const stateDigest = value => digestWithDomain('ZION-COMMITTED-STATE-HARNESS-V1\0', value);

function validateState(state, height) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      state.height !== height || state.schemaVersion !== 1 ||
      !state.data || typeof state.data !== 'object' || Array.isArray(state.data) ||
      !state.operations || typeof state.operations !== 'object' || Array.isArray(state.operations) ||
      !Array.isArray(state.outbox) || typeof state.appHash !== 'string') {
    throw new TypeError('Invalid committed block snapshot');
  }
  const payload = {
    schemaVersion: state.schemaVersion,
    height: state.height,
    data: state.data,
    operations: state.operations,
    outbox: state.outbox,
  };
  if (stateDigest(payload) !== state.appHash) {
    throw Object.assign(new Error('Committed application state root mismatch'), { code: 'ZION_JOURNAL_STATE_ROOT_MISMATCH' });
  }
  return JSON.parse(JSON.stringify(state));
}

function rejectSymlink(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw Object.assign(new Error('Committed block journal path must not be a symbolic link'), {
        code: 'ZION_JOURNAL_SYMLINK',
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function syncDirectory(path) {
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Experimental test-support journal. Each committed height is one complete,
 * hash-chained JSONL record. It is not imported by production code and does not
 * implement consensus, snapshots/compaction, or cross-process lock recovery.
 */
export class DurableCommittedBlockJournal {
  constructor(path, { maxBytes = 256 * 1024 * 1024, crashAfterFsync = false, faultAt = null } = {}) {
    if (typeof path !== 'string' || !path.trim() ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4 * 1024 * 1024 * 1024 ||
        typeof crashAfterFsync !== 'boolean' ||
        ![null, 'before-write', 'after-partial-write', 'before-fsync', 'after-fsync'].includes(faultAt)) {
      throw new TypeError('Invalid committed block journal configuration');
    }
    this.path = resolve(path);
    this.lockPath = this.path + '.lock';
    this.maxBytes = maxBytes;
    this.crashAfterFsync = crashAfterFsync;
    this.faultAt = faultAt;
    this.closed = false;
    this.poisoned = false;
    this.height = 0;
    this.lastHash = ZERO_HASH;
    this.state = null;
    this.byteLength = 0;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let lockFd;
    try {
      lockFd = openSync(this.lockPath, 'wx', 0o600);
      this.lockToken = randomUUID();
      writeSync(lockFd, Buffer.from(JSON.stringify({ pid: process.pid, token: this.lockToken }) + '\n'));
      fsyncSync(lockFd);
      this.lockFd = lockFd;
      syncDirectory(this.lockPath);
      this.#load();
    } catch (error) {
      if (lockFd !== undefined) {
        try { closeSync(lockFd); } catch {}
      }
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        if (lock?.token === this.lockToken && lock?.pid === process.pid) {
          unlinkSync(this.lockPath);
          syncDirectory(this.lockPath);
        }
      } catch {}
      throw error;
    }
  }

  static clearStaleLockAfterVerification(path, { verifiedNoWriter = false } = {}) {
    if (verifiedNoWriter !== true) {
      throw new Error('Explicit confirmation that no writer is active is required');
    }
    const lockPath = resolve(path) + '.lock';
    unlinkSync(lockPath);
    syncDirectory(lockPath);
  }

  #load() {
    rejectSymlink(this.path);
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    if (bytes.length > this.maxBytes) throw Object.assign(new Error('Committed block journal exceeds byte limit'), { code: 'ZION_JOURNAL_TOO_LARGE' });
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
      throw Object.assign(new Error('Committed block journal has an incomplete trailing record'), { code: 'ZION_JOURNAL_CORRUPT' });
    }
    const lines = bytes.toString('utf8').split('\n');
    lines.pop();
    let previousHash = ZERO_HASH;
    let previousState = null;
    for (let i = 0; i < lines.length; i++) {
      let record;
      try { record = JSON.parse(lines[i]); }
      catch { throw Object.assign(new Error('Committed block journal contains invalid JSON'), { code: 'ZION_JOURNAL_CORRUPT' }); }
      if (!record || record.height !== i + 1 || record.previousHash !== previousHash ||
          typeof record.recordHash !== 'string') {
        throw Object.assign(new Error('Committed block journal sequence or chain mismatch'), { code: 'ZION_JOURNAL_CORRUPT' });
      }
      const state = validateState(record.state, record.height);
      const expectedHash = digest({
        height: record.height,
        previousHash: record.previousHash,
        appHash: state.appHash,
        state,
      });
      if (record.appHash !== state.appHash || record.recordHash !== expectedHash) {
        throw Object.assign(new Error('Committed block journal record hash mismatch'), { code: 'ZION_JOURNAL_CORRUPT' });
      }
      previousHash = record.recordHash;
      previousState = state;
    }
    this.height = lines.length;
    this.lastHash = previousHash;
    this.state = previousState;
    this.byteLength = bytes.length;
  }

  read() {
    if (this.closed) throw new Error('Committed block journal is closed');
    return this.state === null ? null : JSON.parse(JSON.stringify(this.state));
  }

  info() {
    return Object.freeze({
      lastBlockHeight: this.height,
      appHash: this.state?.appHash ?? null,
      journalHash: this.lastHash,
    });
  }

  commit(expectedHeight, nextState) {
    if (this.closed || this.poisoned) throw Object.assign(new Error('Committed block journal is unavailable'), { code: 'ZION_JOURNAL_UNAVAILABLE' });
    if (!Number.isSafeInteger(expectedHeight) || expectedHeight < 1) {
      throw Object.assign(new Error('Committed block height conflict'), { code: 'ZION_JOURNAL_HEIGHT_CONFLICT' });
    }
    const state = validateState(nextState, expectedHeight);
    if (expectedHeight === this.height) {
      if (this.state && state.appHash === this.state.appHash) {
        return Object.freeze({ status: 'already-committed', ...this.info() });
      }
      throw Object.assign(new Error('Conflicting state at an already committed height'), { code: 'ZION_JOURNAL_COMMIT_CONFLICT' });
    }
    if (expectedHeight !== this.height + 1) {
      throw Object.assign(new Error('Committed block height conflict'), { code: 'ZION_JOURNAL_HEIGHT_CONFLICT' });
    }
    const recordBase = {
      height: expectedHeight,
      previousHash: this.lastHash,
      appHash: state.appHash,
      state,
    };
    const record = { ...recordBase, recordHash: digest(recordBase) };
    const line = Buffer.from(JSON.stringify(record) + '\n');
    if (this.byteLength + line.length > this.maxBytes) {
      throw Object.assign(new Error('Committed block journal byte limit reached'), { code: 'ZION_JOURNAL_TOO_LARGE' });
    }
    rejectSymlink(this.path);
    const existed = existsSync(this.path);
    const fd = openSync(this.path, 'a', 0o600);
    let originalSize;
    let fdOpen = true;
    try {
      originalSize = fstatSync(fd).size;
      if (this.faultAt === 'before-write') {
        throw Object.assign(new Error('Injected journal failure before write'), { code: 'ZION_JOURNAL_INJECTED_FAILURE' });
      }
      let offset = 0;
      if (this.faultAt === 'after-partial-write') {
        const partialTarget = Math.max(1, Math.floor(line.length / 2));
        while (offset < partialTarget) {
          const written = writeSync(fd, line, offset, partialTarget - offset);
          if (!Number.isInteger(written) || written <= 0) throw new Error('Journal write made no forward progress');
          offset += written;
        }
        throw Object.assign(new Error('Injected journal failure after partial write'), { code: 'ZION_JOURNAL_INJECTED_FAILURE' });
      }
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset);
        if (!Number.isInteger(written) || written <= 0) throw new Error('Journal write made no forward progress');
        offset += written;
      }
      if (this.faultAt === 'before-fsync') {
        throw Object.assign(new Error('Injected journal failure before fsync'), { code: 'ZION_JOURNAL_INJECTED_FAILURE' });
      }
      fsyncSync(fd);
      if (this.faultAt === 'after-fsync') {
        throw Object.assign(new Error('Injected journal failure after fsync'), { code: 'ZION_JOURNAL_INJECTED_FAILURE' });
      }
      if (!existed) syncDirectory(this.path);
      if (this.crashAfterFsync) process.exit(86);
      closeSync(fd);
      fdOpen = false;
    } catch (error) {
      this.poisoned = true;
      if (fdOpen && originalSize !== undefined) {
        try {
          ftruncateSync(fd, originalSize);
          fsyncSync(fd);
        } catch {}
      }
      if (fdOpen) {
        try { closeSync(fd); } catch {}
        fdOpen = false;
      }
      throw error;
    }
    this.height = expectedHeight;
    this.lastHash = record.recordHash;
    this.state = state;
    this.byteLength += line.length;
    return this.info();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd);
      this.lockFd = undefined;
    }
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (lock?.token === this.lockToken && lock?.pid === process.pid) {
        unlinkSync(this.lockPath);
        syncDirectory(this.lockPath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
}

