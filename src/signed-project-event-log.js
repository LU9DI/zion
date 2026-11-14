import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { signPeerMessage, verifyPeerMessage } from './peer-security.js';

const MAX_BYTES_DEFAULT = 64 * 1024 * 1024;
const MAX_RECORDS_DEFAULT = 250_000;
const PROJECT_ID = /^[a-f0-9]{64}$/;
const EVENT_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function acquireLock(lockPath) {
  const token = randomUUID();
  let fd;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
    const bytes = Buffer.from(JSON.stringify({ pid: process.pid, token }) + '\n');
    writeSync(fd, bytes);
    fsyncSync(fd);
    return { fd, token };
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Preserve the original lock acquisition error. */ }
    }
    if (error?.code === 'EEXIST') {
      throw Object.assign(new Error('Event log lock already exists; automatic stale-lock removal is disabled and explicit recovery is required'), {
        code: 'ZION_EVENT_LOG_LOCKED',
      });
    }
    throw error;
  }
}


function cloneAndFreezeJsonValue(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Event payload numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Event payload must contain only JSON values');
  if (ancestors.has(value)) throw new TypeError('Event payload must not contain cycles');
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new TypeError('Event payload arrays must be plain arrays');
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
      throw new TypeError('Event payload arrays must not contain extra properties');
    }
    const copy = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Event payload arrays must be dense data arrays');
      }
      copy.push(cloneAndFreezeJsonValue(descriptor.value, ancestors));
    }
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Event payload objects must be plain objects');
  }
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) {
    throw new TypeError('Event payload objects must not contain symbol keys');
  }
  const copy = {};
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Event payload objects must contain enumerable data properties only');
    }
    Object.defineProperty(copy, key, {
      value: cloneAndFreezeJsonValue(descriptor.value, ancestors),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

function validatePayload(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
}

export function verifySignedProjectEventRecord(record, { now = Date.now(), maxClockSkewMs = 120_000, maxAgeMs = maxClockSkewMs, maxFutureSkewMs = maxClockSkewMs, maxBytes = 1024 * 1024 } = {}) {
  if (!record || typeof record !== 'object' || !record.envelope || typeof record.recordHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.recordHash)) return { ok: false, reason: 'invalid-record' };
  const { envelope } = record;
  const verified = verifyPeerMessage(envelope, { now, maxClockSkewMs, maxAgeMs, maxFutureSkewMs, maxBytes });
  if (!verified.ok) return verified;
  const event = verified.payload;
  if (event.type !== 'PROJECT_EVENT' || !PROJECT_ID.test(event.projectId ?? '') ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !/^[a-f0-9]{64}$/.test(event.previousHash ?? '') ||
      !/^[a-f0-9]{32}$/.test(event.eventId ?? '') || !EVENT_TYPE.test(event.eventType ?? '') ||
      !validatePayload(event.data)) return { ok: false, reason: 'invalid-event' };
  const expected = hash(Buffer.from(JSON.stringify({ envelope, previousHash: event.previousHash })));
  if (expected !== record.recordHash) return { ok: false, reason: 'record-hash-mismatch' };
  return { ok: true, event, nodeId: verified.nodeId };
}

/**
 * Single-writer local durable event journal.
 *
 * This is a node-local append-only log, not distributed consensus. It signs every
 * event, chains records, fsyncs each append, and fails closed on truncation/corruption.
 * A separate quorum protocol must decide which events become committed project state.
 */
export class SignedProjectEventLog {
  constructor(path, { identity, maxBytes = MAX_BYTES_DEFAULT, maxRecords = MAX_RECORDS_DEFAULT,
    now = () => Date.now(), maxClockSkewMs = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof path !== 'string' || !path.trim() || !identity?.privateKey ||
        !/^[a-f0-9]{64}$/.test(identity.nodeId ?? '') || typeof identity.publicKeyPem !== 'string' ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 * 1024 ||
        !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000 ||
        typeof now !== 'function' || !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) {
      throw new TypeError('Invalid signed project event log configuration');
    }
    this.path = resolve(path);
    this.identity = identity;
    this.maxBytes = maxBytes;
    this.maxRecords = maxRecords;
    this.now = now;
    this.maxClockSkewMs = maxClockSkewMs;
    this.records = [];
    this.signedRecords = [];
    this.lastHash = '0'.repeat(64);
    this.byteLength = 0;
    this.persistenceFailed = false;
    this.queue = Promise.resolve();
    this.pendingAppends = 0;
    this.closed = false;
    this.lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = acquireLock(this.lockPath);
    this.lockFd = lock.fd;
    this.lockToken = lock.token;
    try { this.#load(); }
    catch (error) { this.close(); throw error; }
  }

  #load() {
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    if (bytes.length > this.maxBytes) throw Object.assign(new Error('Event log exceeds configured byte limit'), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) {
      throw Object.assign(new Error('Event log has an incomplete trailing record'), { code: 'ZION_EVENT_LOG_CORRUPT' });
    }
    const lines = bytes.toString('utf8').split('\n');
    lines.pop();
    if (lines.length > this.maxRecords) throw Object.assign(new Error('Event log exceeds configured record limit'), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    let previousHash = '0'.repeat(64);
    const records = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); }
      catch { throw Object.assign(new Error('Event log contains invalid JSON'), { code: 'ZION_EVENT_LOG_CORRUPT' }); }
      const checked = verifySignedProjectEventRecord(record, { now: this.now(), maxClockSkewMs: this.maxClockSkewMs });
      if (!checked.ok || checked.nodeId !== this.identity.nodeId ||
          checked.event.sequence !== records.length + 1 || checked.event.previousHash !== previousHash) {
        throw Object.assign(new Error(`Event log integrity validation failed: ${checked.reason ?? 'chain-or-identity-mismatch'}`), { code: 'ZION_EVENT_LOG_CORRUPT' });
      }
      records.push(cloneAndFreezeJsonValue(checked.event));
      this.signedRecords.push(cloneAndFreezeJsonValue({ envelope: record.envelope, recordHash: record.recordHash }));
      previousHash = record.recordHash;
    }
    this.records = records;
    this.lastHash = previousHash;
    this.byteLength = bytes.length;
  }

  append({ projectId, eventType, data } = {}) {
    this.pendingAppends++;
    const operation = this.queue.then(() => this.#append({ projectId, eventType, data }));
    this.queue = operation.catch(() => {});
    return operation.then(
      value => { this.pendingAppends--; return value; },
      error => { this.pendingAppends--; throw error; },
    );
  }

  #append({ projectId, eventType, data }) {
    if (this.closed) throw Object.assign(new Error('Event log is closed'), { code: 'ZION_EVENT_LOG_CLOSED' });
    if (this.persistenceFailed) throw Object.assign(new Error('Event log persistence is unavailable after a failed append'), { code: 'ZION_EVENT_LOG_UNAVAILABLE' });
    if (!PROJECT_ID.test(projectId ?? '') || !EVENT_TYPE.test(eventType ?? '') || !validatePayload(data)) {
      throw new TypeError('Invalid project event');
    }
    if (this.records.length >= this.maxRecords) throw Object.assign(new Error('Event log record limit reached'), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    const immutableData = cloneAndFreezeJsonValue(data);
    const event = {
      type: 'PROJECT_EVENT',
      projectId,
      sequence: this.records.length + 1,
      eventId: randomUUID().replaceAll('-', ''),
      eventType,
      data: immutableData,
      previousHash: this.lastHash,
    };
    const envelope = cloneAndFreezeJsonValue(signPeerMessage(this.identity, event, { now: this.now() }));
    const recordHash = hash(Buffer.from(JSON.stringify({ envelope, previousHash: event.previousHash })));
    const line = Buffer.from(JSON.stringify({ envelope, recordHash }) + '\n');
    if (this.byteLength + line.length > this.maxBytes) throw Object.assign(new Error('Event log byte limit reached'), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    const existed = existsSync(this.path);
    const fd = openSync(this.path, 'a', 0o600);
    let fdOpen = true;
    try {
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset);
        if (!Number.isInteger(written) || written <= 0) throw new Error('Event log write made no forward progress');
        offset += written;
      }
      fsyncSync(fd);
      if (!existed) {
        const dirFd = openSync(dirname(this.path), 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
      closeSync(fd);
      fdOpen = false;
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    } finally {
      if (fdOpen) {
        try { closeSync(fd); } catch { this.persistenceFailed = true; }
      }
    }
    this.byteLength += line.length;
    this.records.push(cloneAndFreezeJsonValue(event));
    this.signedRecords.push(cloneAndFreezeJsonValue({ envelope, recordHash }));
    this.lastHash = recordHash;
    return cloneAndFreezeJsonValue({ ...event, recordHash, signerNodeId: this.identity.nodeId });
  }

  snapshot() {
    return Object.freeze({ count: this.records.length, lastHash: this.lastHash,
      events: Object.freeze(this.records.map(event => cloneAndFreezeJsonValue(event))) });
  }

  /** Signed journal records for authenticated replication; receivers must still commit via quorum. */
  snapshotRecords({ afterSequence = 0, limit = 256 } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError('Invalid signed event replication cursor or limit');
    }
    const records = this.signedRecords.slice(afterSequence, afterSequence + limit)
      .map(record => cloneAndFreezeJsonValue(record));
    return Object.freeze({ fromSequence: afterSequence + 1, nextSequence: afterSequence + records.length + 1,
      lastSequence: this.signedRecords.length, records: Object.freeze(records) });
  }

  close() {
    if (this.closed) return;
    if (this.pendingAppends > 0) {
      throw Object.assign(new Error('Cannot close event log while appends are pending; await them and retry'), {
        code: 'ZION_EVENT_LOG_BUSY',
      });
    }
    this.closed = true;
    if (this.lockFd !== undefined) { try { closeSync(this.lockFd); } finally { this.lockFd = undefined; } }
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
      if (lock?.token === this.lockToken && lock?.pid === process.pid) unlinkSync(this.lockPath);
    } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
}
