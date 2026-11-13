import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { signPeerMessage, verifyPeerMessage } from './peer-security.js';

const MAX_BYTES_DEFAULT = 64 * 1024 * 1024;
const MAX_RECORDS_DEFAULT = 250_000;
const PROJECT_ID = /^[a-f0-9]{64}$/;
const EVENT_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function validatePayload(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) &&
    (Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null);
}

function verifyRecord(record, { now, maxClockSkewMs }) {
  if (!record || typeof record !== 'object' || !record.envelope || typeof record.recordHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.recordHash)) return { ok: false, reason: 'invalid-record' };
  const { envelope } = record;
  const verified = verifyPeerMessage(envelope, { now, maxClockSkewMs, maxBytes: 1024 * 1024 });
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
    this.lastHash = '0'.repeat(64);
    this.queue = Promise.resolve();
    this.closed = false;
    this.lockPath = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.lockFd = openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code === 'EEXIST') throw Object.assign(new Error('Event log is already open by another process'), { code: 'ZION_EVENT_LOG_LOCKED' });
      throw error;
    }
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
      const checked = verifyRecord(record, { now: this.now(), maxClockSkewMs: this.maxClockSkewMs });
      if (!checked.ok || checked.nodeId !== this.identity.nodeId ||
          checked.event.sequence !== records.length + 1 || checked.event.previousHash !== previousHash) {
        throw Object.assign(new Error(`Event log integrity validation failed: ${checked.reason ?? 'chain-or-identity-mismatch'}`), { code: 'ZION_EVENT_LOG_CORRUPT' });
      }
      records.push(Object.freeze({ ...checked.event }));
      previousHash = record.recordHash;
    }
    this.records = records;
    this.lastHash = previousHash;
  }

  append({ projectId, eventType, data } = {}) {
    const operation = this.queue.then(() => this.#append({ projectId, eventType, data }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  #append({ projectId, eventType, data }) {
    if (this.closed) throw Object.assign(new Error('Event log is closed'), { code: 'ZION_EVENT_LOG_CLOSED' });
    if (!PROJECT_ID.test(projectId ?? '') || !EVENT_TYPE.test(eventType ?? '') || !validatePayload(data)) {
      throw new TypeError('Invalid project event');
    }
    if (this.records.length >= this.maxRecords) throw Object.assign(new Error('Event log record limit reached'), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    const event = {
      type: 'PROJECT_EVENT',
      projectId,
      sequence: this.records.length + 1,
      eventId: randomUUID().replaceAll('-', ''),
      eventType,
      data,
      previousHash: this.lastHash,
    };
    const envelope = signPeerMessage(this.identity, event, { now: this.now() });
    const recordHash = hash(Buffer.from(JSON.stringify({ envelope, previousHash: event.previousHash })));
    const line = Buffer.from(JSON.stringify({ envelope, recordHash }) + '\n');
    const currentBytes = existsSync(this.path) ? readFileSync(this.path).length : 0;
    if (currentBytes + line.length > this.maxBytes) throw Object.assign(new Error('Event log byte limit reached'), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    const fd = openSync(this.path, 'a', 0o600);
    try {
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    this.records.push(Object.freeze({ ...event }));
    this.lastHash = recordHash;
    return Object.freeze({ ...event, recordHash, signerNodeId: this.identity.nodeId });
  }

  snapshot() {
    return Object.freeze({ count: this.records.length, lastHash: this.lastHash,
      events: Object.freeze(this.records.map(event => Object.freeze({ ...event }))) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.lockFd !== undefined) { try { closeSync(this.lockFd); } finally { this.lockFd = undefined; } }
    try { unlinkSync(this.lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}
