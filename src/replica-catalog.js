import { randomBytes, createHash } from 'node:crypto';
import { mkdir, lstat, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const NODE = /^[a-f0-9]{64}$/;
const VERSION = 1;

/** Durable local metadata catalog. Stored receipts are historical claims, not proof of current availability. */
export class ReplicaCatalog {
  constructor(root, { maxEntries = 100_000, lockTimeoutMs = 2_000, now = () => Date.now() } = {}) {
    if (typeof root !== 'string' || !root || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000 ||
      !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 50 || lockTimeoutMs > 30_000 || typeof now !== 'function') throw new TypeError('Invalid replica catalog configuration');
    this.root = path.resolve(root); this.file = path.join(this.root, 'catalog.json'); this.lock = path.join(this.root, '.catalog.lock');
    this.maxEntries = maxEntries; this.lockTimeoutMs = lockTimeoutMs; this.now = now; this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await lstat(this.root);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Catalog root must be a real directory');
    try { await chmod(this.root, 0o700); } catch (e) { if (!['EPERM', 'ENOTSUP', 'EINVAL', 'ENOSYS'].includes(e.code)) throw e; }
    try { await this.#read(); } catch (e) { if (e.code !== 'ENOENT') throw e; await this.#mutate(state => state); }
  }

  async get(chunkId) {
    this.#assertHash(chunkId);
    const state = await this.#read();
    const item = state.entries[chunkId];
    return item ? structuredClone(item) : null;
  }

  async list({ limit = 1000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('Invalid catalog list limit');
    const state = await this.#read();
    return Object.values(state.entries).slice(0, limit).map(item => structuredClone(item));
  }

  async recordReplication({ chunkId, bytes, desiredReplicas = 3, receipts = [] } = {}) {
    this.#assertHash(chunkId);
    if (!Number.isSafeInteger(bytes) || bytes < 33 || bytes > 64 * 1024 * 1024 || !Number.isSafeInteger(desiredReplicas) || desiredReplicas < 1 || desiredReplicas > 100 || !Array.isArray(receipts) || receipts.length > 100) throw new TypeError('Invalid replication metadata');
    const unique = new Map();
    for (const receipt of receipts) {
      if (!receipt || !NODE.test(receipt.nodeId ?? '') || receipt.chunkId !== chunkId || receipt.storedBytes !== bytes || !Number.isSafeInteger(receipt.storedAt)) throw new TypeError('Invalid replication receipt metadata');
      if (unique.has(receipt.nodeId)) throw new Error('Duplicate node receipt');
      unique.set(receipt.nodeId, { nodeId: receipt.nodeId, storedBytes: receipt.storedBytes, storedAt: receipt.storedAt, requestId: receipt.requestId });
    }
    return this.#mutate(state => {
      if (!state.entries[chunkId] && Object.keys(state.entries).length >= this.maxEntries) throw new Error('Replica catalog capacity reached');
      const previous = state.entries[chunkId];
      state.entries[chunkId] = {
        chunkId, bytes, desiredReplicas,
        receipts: [...unique.values()],
        createdAt: previous?.createdAt ?? this.now(), updatedAt: this.now(),
        status: unique.size >= desiredReplicas ? 'replication-confirmed' : 'under-replicated',
        availability: previous?.availability ?? { status: 'unverified', checkedAt: null, observations: {} }
      };
      return structuredClone(state.entries[chunkId]);
    });
  }

  /** Store fresh availability observations separately from historical signed receipts. */
  async recordAvailability({ chunkId, observations } = {}) {
    this.#assertHash(chunkId);
    if (!Array.isArray(observations) || observations.length > 100) throw new TypeError('Invalid availability observations');
    const unique = new Map();
    for (const item of observations) {
      if (!item || !NODE.test(item.nodeId ?? '') || typeof item.available !== 'boolean' || !Number.isSafeInteger(item.checkedAt) ||
        !['verified', 'unavailable-or-invalid', 'timeout', 'not-connected'].includes(item.reason)) throw new TypeError('Invalid availability observation');
      if (unique.has(item.nodeId)) throw new Error('Duplicate availability observation');
      unique.set(item.nodeId, { nodeId: item.nodeId, available: item.available, checkedAt: item.checkedAt, reason: item.reason });
    }
    return this.#mutate(state => {
      const entry = state.entries[chunkId];
      if (!entry) throw new Error('Chunk is not in replica catalog');
      const previous = entry.availability?.observations ?? {};
      const merged = { ...previous };
      for (const [nodeId, observation] of unique) {
        if (entry.receipts.some(receipt => receipt.nodeId === nodeId)) merged[nodeId] = observation;
      }
      const receiptIds = entry.receipts.map(receipt => receipt.nodeId);
      const checked = receiptIds.map(id => merged[id]).filter(Boolean);
      const availableCount = checked.filter(item => item.available).length;
      const allChecked = receiptIds.length > 0 && checked.length === receiptIds.length;
      entry.availability = {
        status: availableCount >= entry.desiredReplicas ? 'verified-available' : allChecked ? 'under-replicated' : checked.length ? 'partially-verified' : 'unverified',
        checkedAt: checked.length ? Math.max(...checked.map(item => item.checkedAt)) : null,
        observations: merged
      };
      entry.updatedAt = this.now();
      return structuredClone(entry.availability);
    });
  }

  /** Record current unavailability without rewriting the historical receipt ledger. */
  async markNodeUnavailable(nodeId, { reason = 'not-connected' } = {}) {
    if (!NODE.test(nodeId ?? '') || !['not-connected', 'unavailable-or-invalid', 'timeout'].includes(reason)) throw new TypeError('Invalid node unavailability');
    return this.#mutate(state => {
      let changed = 0;
      const checkedAt = this.now();
      for (const item of Object.values(state.entries)) {
        if (!item.receipts.some(receipt => receipt.nodeId === nodeId)) continue;
        const previous = item.availability?.observations ?? {};
        const merged = { ...previous, [nodeId]: { nodeId, available: false, checkedAt, reason } };
        const receiptIds = item.receipts.map(receipt => receipt.nodeId);
        const checked = receiptIds.map(id => merged[id]).filter(Boolean);
        const availableCount = checked.filter(observation => observation.available).length;
        const allChecked = receiptIds.length > 0 && checked.length === receiptIds.length;
        item.availability = {
          status: availableCount >= item.desiredReplicas ? 'verified-available' : allChecked ? 'under-replicated' : checked.length ? 'partially-verified' : 'unverified',
          checkedAt: checked.length ? Math.max(...checked.map(observation => observation.checkedAt)) : null,
          observations: merged
        };
        item.updatedAt = checkedAt;
        changed++;
      }
      return { changed };
    });
  }

  async #read() {
    let st;
    try { st = await lstat(this.file); } catch (e) { throw e; }
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) throw new Error('Invalid or oversized replica catalog file');
    const text = await readFile(this.file, 'utf8');
    let state; try { state = JSON.parse(text); } catch { throw new Error('Replica catalog is corrupt; refusing to overwrite it'); }
    if (!state || state.version !== VERSION || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)) throw new Error('Unsupported or invalid replica catalog schema');
    const entries = Object.entries(state.entries);
    if (entries.length > this.maxEntries) throw new Error('Replica catalog exceeds configured entry limit');
    for (const [id, item] of entries) {
      if (!HASH.test(id) || item?.chunkId !== id || !Number.isSafeInteger(item.bytes) || item.bytes < 33 || !Number.isSafeInteger(item.desiredReplicas) || item.desiredReplicas < 1 || !Array.isArray(item.receipts) || !Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.updatedAt)) throw new Error('Replica catalog entry validation failed');
      const seen = new Set();
      for (const r of item.receipts) { if (!NODE.test(r?.nodeId ?? '') || seen.has(r.nodeId) || !Number.isSafeInteger(r.storedAt)) throw new Error('Replica catalog receipt validation failed'); seen.add(r.nodeId); }
      if (item.availability !== undefined) {
        const a = item.availability;
        if (!a || !['unverified', 'verified-available', 'partially-verified', 'under-replicated'].includes(a.status) ||
          !(a.checkedAt === null || Number.isSafeInteger(a.checkedAt)) || !a.observations || typeof a.observations !== 'object' || Array.isArray(a.observations)) throw new Error('Replica catalog availability validation failed');
        for (const [nodeId, observation] of Object.entries(a.observations)) if (!NODE.test(nodeId) || observation?.nodeId !== nodeId || typeof observation.available !== 'boolean' || !Number.isSafeInteger(observation.checkedAt) || !['verified', 'unavailable-or-invalid', 'timeout', 'not-connected'].includes(observation.reason)) throw new Error('Replica catalog availability observation validation failed');
      }
    }
    return state;
  }

  #mutate(fn) {
    const operation = this.queue.then(() => this.#withLock(async () => {
      let state;
      try { state = await this.#read(); } catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: VERSION, entries: {} }; }
      const result = fn(state);
      await this.#write(state);
      return result;
    }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async #withLock(fn) {
    const deadline = this.now() + this.lockTimeoutMs;
    let handle;
    while (!handle) {
      try { handle = await open(this.lock, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (this.now() >= deadline) throw new Error('Replica catalog lock is busy; refusing unsafe concurrent update');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomBytes(8).toString('hex'), createdAt: this.now() })); await handle.sync(); return await fn(); }
    finally { await handle.close().catch(() => {}); await unlink(this.lock).catch(() => {}); }
  }

  async #write(state) {
    const temp = path.join(this.root, `.catalog-${randomBytes(16).toString('hex')}.tmp`);
    let handle;
    try {
      handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await rename(temp, this.file);
      // Directory-handle fsync is unsupported by Node.js on Windows (EPERM).
      // The catalog file is synced before rename; Windows directory-entry durability is weaker.
      if (process.platform !== 'win32') {
        const dir = await open(this.root, fsConstants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally { if (handle) await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }

  #assertHash(id) { if (!HASH.test(id ?? '')) throw new TypeError('Invalid chunk id'); }
}

export function catalogDigest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
