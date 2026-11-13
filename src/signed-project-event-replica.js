import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { verifySignedProjectEventRecord } from './signed-project-event-log.js';

function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      const bytes = Buffer.from(JSON.stringify({ pid: process.pid, token }) + '\n');
      writeSync(fd, bytes);
      fsyncSync(fd);
      return { fd, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let lock;
      try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); }
      catch { throw Object.assign(new Error('Event log lock is unreadable; manual recovery is required'), { code: 'ZION_EVENT_LOG_LOCKED' }); }
      if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1 || typeof lock.token !== 'string') {
        throw Object.assign(new Error('Event log lock is invalid; manual recovery is required'), { code: 'ZION_EVENT_LOG_LOCKED' });
      }
      try { process.kill(lock.pid, 0); }
      catch (probeError) {
        if (probeError?.code !== 'ESRCH') throw Object.assign(new Error('Event log lock owner cannot be verified'), { code: 'ZION_EVENT_LOG_LOCKED' });
        try { unlinkSync(lockPath); } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
      }
    }
  }
  throw Object.assign(new Error('Event log is already open by another process'), { code: 'ZION_EVENT_LOG_LOCKED' });
}

// Durable receiver for signed per-node journals. This is replication storage only;
// it does not decide project membership, quorum commitment, or canonical project state.
export class SignedProjectEventReplica {
  constructor(path, { authorizePeer, maxBytes = 256 * 1024 * 1024,
    maxRecords = 1_000_000, now = () => Date.now(), maxClockSkewMs = 120_000, maxEventAgeMs = Number.MAX_SAFE_INTEGER } = {}) {
    if (typeof path !== 'string' || !path.trim() || typeof authorizePeer !== 'function' ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 4 * 1024 * 1024 * 1024 ||
        !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5_000_000 ||
        typeof now !== 'function' || !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0 ||
        !Number.isSafeInteger(maxEventAgeMs) || maxEventAgeMs < 0) {
      throw new TypeError('Invalid signed event replica configuration');
    }
    this.path = resolve(path);
    this.authorizePeer = authorizePeer;
    this.maxBytes = maxBytes;
    this.maxRecords = maxRecords;
    this.now = now;
    this.maxClockSkewMs = maxClockSkewMs;
    this.maxEventAgeMs = maxEventAgeMs;
    this.states = new Map();
    this.records = 0;
    this.byteLength = 0;
    this.closed = false;
    this.persistenceFailed = false;
    this.queue = Promise.resolve();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = acquireLock(`${this.path}.lock`);
    this.lockFd = lock.fd;
    this.lockToken = lock.token;
    try { this.#load(); } catch (error) { this.close(); throw error; }
  }

  #load() {
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    if (bytes.length > this.maxBytes) throw Object.assign(new Error('Replica journal exceeds byte limit'), { code: 'ZION_REPLICA_TOO_LARGE' });
    if (bytes.length && bytes[bytes.length - 1] !== 0x0a) throw Object.assign(new Error('Replica journal has incomplete trailing record'), { code: 'ZION_REPLICA_CORRUPT' });
    const lines = bytes.toString('utf8').split('\n');
    lines.pop();
    if (lines.length > this.maxRecords) throw Object.assign(new Error('Replica journal exceeds record limit'), { code: 'ZION_REPLICA_TOO_LARGE' });
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch {
        throw Object.assign(new Error('Replica journal contains invalid JSON'), { code: 'ZION_REPLICA_CORRUPT' });
      }
      const checked = verifySignedProjectEventRecord(record, { now: this.now(), maxClockSkewMs: this.maxClockSkewMs, maxAgeMs: this.maxEventAgeMs, maxFutureSkewMs: this.maxClockSkewMs });
      if (!checked.ok) throw Object.assign(new Error('Replica journal signature or record hash is invalid'), { code: 'ZION_REPLICA_CORRUPT' });
      const event = checked.event;
      const state = this.states.get(checked.nodeId) ?? { sequence: 0, lastHash: '0'.repeat(64), hashes: [] };
      if (event.sequence !== state.sequence + 1 || event.previousHash !== state.lastHash) {
        throw Object.assign(new Error('Replica journal contains a sequence gap or fork'), { code: 'ZION_REPLICA_CORRUPT' });
      }
      state.sequence = event.sequence;
      state.lastHash = record.recordHash;
      state.hashes.push(record.recordHash);
      this.states.set(checked.nodeId, state);
      this.records++;
    }
    this.byteLength = bytes.length;
  }

  ingest(record) {
    const operation = this.queue.then(() => this.#ingest(record));
    this.queue = operation.catch(() => {});
    return operation;
  }

  #ingest(record) {
    if (this.closed) throw Object.assign(new Error('Replica is closed'), { code: 'ZION_REPLICA_CLOSED' });
    if (this.persistenceFailed) throw Object.assign(new Error('Replica persistence unavailable after failed append'), { code: 'ZION_REPLICA_UNAVAILABLE' });
    const checked = verifySignedProjectEventRecord(record, { now: this.now(), maxClockSkewMs: this.maxClockSkewMs, maxAgeMs: this.maxEventAgeMs, maxFutureSkewMs: this.maxClockSkewMs });
    if (!checked.ok) throw Object.assign(new Error(`Invalid signed event: ${checked.reason}`), { code: 'ZION_REPLICA_INVALID_RECORD' });
    const { nodeId, event } = checked;
    if (this.authorizePeer(nodeId, event.projectId) !== true) {
      throw Object.assign(new Error('Peer is not authorized to replicate this project'), { code: 'ZION_REPLICA_UNAUTHORIZED' });
    }
    const state = this.states.get(nodeId) ?? { sequence: 0, lastHash: '0'.repeat(64), hashes: [] };
    if (event.sequence <= state.sequence) {
      if (state.hashes[event.sequence - 1] === record.recordHash) return Object.freeze({ accepted: false, duplicate: true, nodeId, sequence: event.sequence, recordHash: record.recordHash });
      throw Object.assign(new Error('Conflicting record for an already observed peer sequence'), { code: 'ZION_REPLICA_EQUIVOCATION' });
    }
    if (event.sequence !== state.sequence + 1 || event.previousHash !== state.lastHash) {
      throw Object.assign(new Error('Replication record is out of order or does not extend the accepted chain'), { code: 'ZION_REPLICA_GAP' });
    }
    if (this.records >= this.maxRecords) throw Object.assign(new Error('Replica record limit reached'), { code: 'ZION_REPLICA_TOO_LARGE' });
    const line = Buffer.from(JSON.stringify({ envelope: record.envelope, recordHash: record.recordHash }) + '\n');
    if (this.byteLength + line.length > this.maxBytes) throw Object.assign(new Error('Replica byte limit reached'), { code: 'ZION_REPLICA_TOO_LARGE' });
    const existed = existsSync(this.path);
    const fd = openSync(this.path, 'a', 0o600);
    try {
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
      fsyncSync(fd);
      if (!existed) {
        const dirFd = openSync(dirname(this.path), 'r');
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    } finally { closeSync(fd); }
    state.sequence = event.sequence;
    state.lastHash = record.recordHash;
    state.hashes.push(record.recordHash);
    this.states.set(nodeId, state);
    this.records++;
    this.byteLength += line.length;
    return Object.freeze({ accepted: true, duplicate: false, nodeId, sequence: event.sequence, recordHash: record.recordHash });
  }

  snapshot() {
    return Object.freeze({
      records: this.records,
      peers: Object.freeze([...this.states.entries()].map(([nodeId, state]) =>
        Object.freeze({ nodeId, sequence: state.sequence, lastHash: state.lastHash }))),
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.lockFd !== undefined) { try { closeSync(this.lockFd); } finally { this.lockFd = undefined; } }
    try {
      const lock = JSON.parse(readFileSync(`${this.path}.lock`, 'utf8'));
      if (lock?.token === this.lockToken && lock?.pid === process.pid) unlinkSync(`${this.path}.lock`);
    } catch (error) { if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
}
