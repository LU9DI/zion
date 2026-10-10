import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, chmod, readdir, readFile, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createStoreReceipt, validateStoreRequest } from './replication-receipts.js';
import { PeerAbuseGuard } from './fair-share-policy.js';

const SHA256 = /^[a-f0-9]{64}$/;
const TRANSFER_ID = /^[a-f0-9]{32}$/;
const ENVELOPE_MAGIC = Buffer.from('REAC1');
const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STORAGE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_PART_BYTES = 96 * 1024;

/** Stores already-encrypted REAC1 envelopes without possessing users' encryption keys. */
export class OpaqueReplicaStore {
  constructor(root, { maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES, maxStorageBytes = DEFAULT_MAX_STORAGE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 33 || maxChunkBytes > 64 * 1024 * 1024) throw new RangeError('Invalid opaque chunk limit');
    if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < maxChunkBytes || maxStorageBytes > Number.MAX_SAFE_INTEGER) throw new RangeError('Invalid opaque storage quota');
    this.root = path.resolve(root); this.maxChunkBytes = maxChunkBytes; this.maxStorageBytes = maxStorageBytes;
    this.queue = Promise.resolve(); this.lockPath = path.join(this.root, '.rea-replica-write-lock');
    this.quotaConfigPath = path.join(this.root, '.rea-storage-config.json');
    this.lockWaitMs = 5000; this.lockStaleMs = 30_000;
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await lstat(this.root);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Replica root must be a real directory');
    try { await chmod(this.root, 0o700); } catch (e) { if (!['EPERM','ENOTSUP','EINVAL','ENOSYS'].includes(e.code)) throw e; }
    await this.#withProcessLock(async () => { await this.#syncQuotaConfigLocked(); });
  }
  async #syncQuotaConfigLocked() {
    let stat;
    try { stat = await lstat(this.quotaConfigPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#writeQuotaConfigLocked(this.maxStorageBytes);
      return this.maxStorageBytes;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Storage quota config must be a bounded regular non-symlink file');
    const saved = JSON.parse(await readFile(this.quotaConfigPath, 'utf8'));
    if (saved?.version !== 1 || !Number.isSafeInteger(saved.capacityBytes) || saved.capacityBytes < this.maxChunkBytes || saved.capacityBytes > Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid persisted storage quota configuration');
    }
    this.maxStorageBytes = saved.capacityBytes;
    return this.maxStorageBytes;
  }
  async #writeQuotaConfigLocked(capacityBytes) {
    const temp = path.join(this.root, `.tmp-quota-${randomBytes(12).toString('hex')}`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, capacityBytes }));
      await handle.sync(); await handle.close(); handle = null;
      await rename(temp, this.quotaConfigPath);
      this.maxStorageBytes = capacityBytes;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  #path(id) {
    if (!SHA256.test(id ?? '')) throw new TypeError('Invalid chunk id');
    return path.join(this.root, id.slice(0, 2), id.slice(2));
  }
  async put(id, envelope) {
    if (!Buffer.isBuffer(envelope)) throw new TypeError('Opaque chunk must be a Buffer');
    if (envelope.length < 33 || envelope.length > this.maxChunkBytes) throw new RangeError('Opaque chunk size is outside configured limits');
    if (!envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) throw new Error('Invalid encrypted chunk envelope');
    const actual = createHash('sha256').update(envelope).digest('hex');
    if (actual !== id) throw new Error('Chunk digest mismatch');
    const operation = this.queue.then(() => this.#withProcessLock(() => this.#putLocked(id, envelope)));
    this.queue = operation.catch(() => {});
    return operation;
  }
  async #withProcessLock(operation) {
    const started = Date.now(); const token = randomBytes(16).toString('hex');
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        try {
          const ownerPath = path.join(this.lockPath, 'owner.json');
          const handle = await open(ownerPath, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); await handle.sync(); }
          finally { await handle.close(); }
        } catch (error) { await rm(this.lockPath, { recursive: true, force: true }).catch(() => {}); throw error; }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this.#reapDeadLockIfSafe();
        if (Date.now() - started >= this.lockWaitMs) { const timeout = new Error('Replica storage lock busy; refusing unsafe concurrent write'); timeout.code = 'REA_LOCK_TIMEOUT'; throw timeout; }
        await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
      }
    }
    try { return await operation(); }
    finally {
      try { const owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8'));
        if (owner.pid === process.pid && owner.token === token) await rm(this.lockPath, { recursive: true, force: true });
      } catch { /* fail closed if ownership cannot be verified */ }
    }
  }
  async #reapDeadLockIfSafe() {
    let info; let owner;
    try {
      info = await lstat(this.lockPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Replica storage lock is not a real directory');
      owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (Date.now() - (info?.mtimeMs ?? Date.now()) < this.lockStaleMs) return;
      owner = null;
    }
    if (owner) {
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !Number.isFinite(owner.createdAt) || Date.now() - owner.createdAt < this.lockStaleMs) return;
      try { process.kill(owner.pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; }
    }
    const quarantine = `${this.lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
    try { await rename(this.lockPath, quarantine); await rm(quarantine, { recursive: true, force: true }); }
    catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
  }
  async #putLocked(id, envelope) {
    await this.#syncQuotaConfigLocked();
    const target = this.#path(id); const dir = path.dirname(target);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirStat = await lstat(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('Invalid replica shard directory');
    try {
      const existing = await this.get(id);
      if (!existing.equals(envelope)) throw new Error('Existing replica content mismatch');
      return Object.freeze({ id, bytes: existing.length, alreadyPresent: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const used = await this.sizeBytes();
    if (used + envelope.length > this.maxStorageBytes) { const error = new Error('Replica storage quota exceeded'); error.code = 'REA_CAPACITY_EXHAUSTED'; error.availableBytes = Math.max(0, this.maxStorageBytes - used); throw error; }
    const temp = path.join(dir, `.tmp-${randomBytes(16).toString('hex')}`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(envelope); await handle.sync(); await handle.close(); handle = null;
      try { await link(temp, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await this.get(id);
        if (!existing.equals(envelope)) throw new Error('Conflicting replica already exists');
        return Object.freeze({ id, bytes: existing.length, alreadyPresent: true });
      }
    } finally { if (handle) await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); }
    return Object.freeze({ id, bytes: envelope.length, alreadyPresent: false });
  }
  async get(id) {
    const file = this.#path(id); const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await open(file, fsConstants.O_RDONLY | noFollow);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size < 33 || st.size > this.maxChunkBytes) throw new Error('Invalid stored replica file');
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== id || !bytes.subarray(0, 5).equals(ENVELOPE_MAGIC)) throw new Error('Stored replica integrity check failed');
      return bytes;
    } finally { await handle.close(); }
  }
  /**
   * Audits the actual local replica inventory before it is used as contribution credit.
   * Every file is re-read and content-address verified; any unexpected entry or corrupt
   * chunk aborts the audit so callers cannot grant credits from stale size metadata.
   */
  async auditInventory({ maxEntries = 100_000, batchSize = 128, shouldContinue = null, checkpointPath = null } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid inventory audit limit');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 4096) throw new TypeError('Invalid inventory audit batch size');
    if (shouldContinue !== null && typeof shouldContinue !== 'function') throw new TypeError('Invalid inventory audit continuation gate');
    const checkpoint = checkpointPath === null ? null : path.resolve(checkpointPath);
    if (checkpoint && (checkpoint === this.root || checkpoint.startsWith(`${this.root}${path.sep}`))) {
      throw new TypeError('Audit checkpoint must be outside the replica storage root');
    }
    const operation = this.queue.then(() => this.#withProcessLock(async () => {
      const checkContinuation = async () => {
        if (shouldContinue && await shouldContinue() !== true) {
          const error = new Error('Replica inventory audit paused because local resource budget is unavailable');
          error.code = 'REA_AUDIT_PAUSED';
          throw error;
        }
      };
      await checkContinuation();

      // Enumerate a bounded, deterministic inventory first. The writer lock prevents
      // cooperating REA writers from changing it during this audit.
      const ids = [];
      const walk = async (dir, prefix = '', depth = 0) => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.name === '.rea-replica-write-lock' || ent.name.startsWith('.rea-replica-write-lock.stale-') || ent.name === '.rea-storage-config.json') continue;
          if (ent.isSymbolicLink()) throw new Error('Symlinks are forbidden in replica inventory');
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (depth !== 0 || !/^[a-f0-9]{2}$/.test(ent.name)) throw new Error('Unexpected directory in replica inventory');
            await walk(full, ent.name, 1); continue;
          }
          if (!ent.isFile()) throw new Error('Unexpected filesystem entry in replica inventory');
          if (ent.name.startsWith('.tmp-')) continue;
          if (depth !== 1 || !/^[a-f0-9]{62}$/.test(ent.name)) throw new Error('Unexpected file in replica inventory');
          if (ids.length >= maxEntries) throw new Error('Replica inventory audit entry limit exceeded');
          ids.push(prefix + ent.name);
        }
      };
      let roots;
      try { roots = await readdir(this.root, { withFileTypes: true }); }
      catch (error) {
        if (error.code === 'ENOENT') return Object.freeze({ verifiedBytes: 0, chunkCount: 0, chunks: Object.freeze([]), resumed: false });
        throw error;
      }
      for (const ent of roots) {
        if (ent.name === '.rea-replica-write-lock' || ent.name.startsWith('.rea-replica-write-lock.stale-') || ent.name === '.rea-storage-config.json') continue;
        if (!ent.isDirectory() || ent.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(ent.name)) throw new Error('Unexpected entry in replica inventory root');
        await walk(path.join(this.root, ent.name), ent.name, 1);
      }
      ids.sort();

      let nextIndex = 0;
      let resumed = false;
      if (checkpoint) {
        try {
          const st = await lstat(checkpoint);
          if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024 * 1024) throw new Error('Audit checkpoint is not a bounded regular file');
          const state = JSON.parse(await readFile(checkpoint, 'utf8'));
          if (state?.version !== 1 || !Array.isArray(state.ids) || !Number.isSafeInteger(state.nextIndex) ||
              state.nextIndex < 0 || state.nextIndex > state.ids.length || state.ids.length > maxEntries ||
              state.ids.some(id => typeof id !== 'string' || !SHA256.test(id)) ||
              state.ids.some((id, i) => i > 0 && state.ids[i - 1] >= id)) {
            throw new Error('Audit checkpoint schema is invalid');
          }
          if (state.ids.length !== ids.length || state.ids.some((id, i) => id !== ids[i])) {
            const error = new Error('Replica inventory changed since the saved audit checkpoint');
            error.code = 'REA_AUDIT_INVENTORY_CHANGED';
            throw error;
          }
          nextIndex = state.nextIndex;
          resumed = nextIndex > 0;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }

      const saveCheckpoint = async index => {
        if (!checkpoint) return;
        const parent = path.dirname(checkpoint);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const parentStat = await lstat(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Audit checkpoint parent must be a real directory');
        const temp = `${checkpoint}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
        let handle;
        try {
          handle = await open(temp, 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ version: 1, ids, nextIndex: index }));
          await handle.sync(); await handle.close(); handle = null;
          try { await rename(temp, checkpoint); }
          catch (error) { if (error.code !== 'ENOENT') throw error; throw error; }
        } finally {
          if (handle) await handle.close().catch(() => {});
          await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      };

      // A checkpoint is progress metadata, never trusted contribution. On restart,
      // re-hash the completed prefix before continuing at the saved cursor. The
      // storage lock blocks cooperating REA writers throughout both phases.
      const chunks = []; let verifiedBytes = 0; let sinceYield = 0;
      const verifyAt = async i => {
        const bytes = await this.get(ids[i]);
        verifiedBytes += bytes.length;
        chunks.push(Object.freeze({ id: ids[i], bytes: bytes.length }));
      };
      for (let i = 0; i < nextIndex; i++) {
        await verifyAt(i);
        sinceYield++;
        if (sinceYield >= batchSize || i === nextIndex - 1) {
          sinceYield = 0;
          await new Promise(resolve => setImmediate(resolve));
          await checkContinuation();
        }
      }
      for (let i = nextIndex; i < ids.length; i++) {
        await verifyAt(i);
        sinceYield++;
        if (sinceYield >= batchSize || i === ids.length - 1) {
          sinceYield = 0;
          await saveCheckpoint(i + 1);
          await new Promise(resolve => setImmediate(resolve));
          await checkContinuation();
        }
      }
      if (checkpoint) {
        try {
          const st = await lstat(checkpoint);
          if (!st.isFile() || st.isSymbolicLink()) throw new Error('Audit checkpoint changed to a non-regular file');
          await unlink(checkpoint);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return Object.freeze({ verifiedBytes, chunkCount: chunks.length, chunks: Object.freeze(chunks), resumed });
    }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async getCapacityBytes() {
    const operation = this.queue.then(() => this.#withProcessLock(() => this.#syncQuotaConfigLocked()));
    this.queue = operation.catch(() => {});
    return operation;
  }

  /**
   * Atomically changes this store instance's admission quota only when the actual
   * on-disk inventory fits. This does not evict or delete replicas. The host must
   * persist/reload quota configuration if it needs to survive process restarts.
   */
  async setCapacityBytes(targetBytes) {
    if (!Number.isSafeInteger(targetBytes) || targetBytes < this.maxChunkBytes || targetBytes > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Storage quota must be a safe integer at least as large as maxChunkBytes');
    }
    const operation = this.queue.then(() => this.#withProcessLock(async () => {
      await this.#syncQuotaConfigLocked();
      const usedBytes = await this.sizeBytes();
      if (usedBytes > targetBytes) {
        const error = new Error('Cannot lower storage quota below currently occupied replica bytes');
        error.code = 'REA_QUOTA_REDUCTION_UNSAFE';
        error.usedBytes = usedBytes;
        error.targetBytes = targetBytes;
        throw error;
      }
      await this.#writeQuotaConfigLocked(targetBytes);
      return Object.freeze({ capacityBytes: this.maxStorageBytes, usedBytes });
    }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async sizeBytes() {
    let total = 0;
    const walk = async (dir, depth = 0) => {
      let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const ent of entries) {
        if (depth === 0 && ent.name === '.rea-storage-config.json') continue;
        const full = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) throw new Error('Symlinks are forbidden in replica storage');
        if (ent.isDirectory()) {
          if (depth === 0 && /^[a-f0-9]{2}$/.test(ent.name)) await walk(full, depth + 1);
          else if (depth > 0) throw new Error('Unexpected nested directory in replica storage');
        } else if (ent.isFile()) {
          if (depth !== 1 || !/^[a-f0-9]{62}$/.test(ent.name)) { if (!ent.name.startsWith('.tmp-')) throw new Error('Unexpected file in replica storage'); continue; }
          total += (await lstat(full)).size;
        }
      }
    };
    await walk(this.root); return total;
  }
}

/** Bounded segmented transfer handler. Call from PeerTransport.onMessage. */
export class PeerStorageService {
  constructor({ identity, store, maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES, partBytes = DEFAULT_PART_BYTES,
    maxTransfers = 8, maxBufferedBytes = 16 * 1024 * 1024, transferTtlMs = 30_000, abuseGuard = new PeerAbuseGuard(), integrityGuard = null, now = () => Date.now() } = {}) {
    if (!identity?.privateKey || !store || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 33 ||
      !Number.isSafeInteger(partBytes) || partBytes < 1024 || partBytes > 128 * 1024 ||
      !Number.isSafeInteger(maxTransfers) || maxTransfers < 1 || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < maxChunkBytes ||
      !Number.isSafeInteger(transferTtlMs) || transferTtlMs < 1000 || typeof now !== 'function') throw new TypeError('Invalid peer storage service configuration');
    this.identity = identity; this.store = store; this.maxChunkBytes = maxChunkBytes; this.partBytes = partBytes;
    if (abuseGuard !== null && typeof abuseGuard.reserve !== 'function') throw new TypeError('Invalid peer abuse guard');
    if (integrityGuard !== null && typeof integrityGuard.assertHealthy !== 'function') throw new TypeError('Invalid integrity guard');
    this.maxTransfers = maxTransfers; this.maxBufferedBytes = maxBufferedBytes; this.transferTtlMs = transferTtlMs; this.abuseGuard = abuseGuard; this.integrityGuard = integrityGuard; this.now = now;
    this.transfers = new Map(); this.bufferedBytes = 0; this.pendingGets = new Map();
    this.removeQuarantineListener = typeof integrityGuard?.addQuarantineListener === 'function'
      ? integrityGuard.addQuarantineListener(report => this.#enterQuarantine(report?.reason ?? 'Zion integrity quarantine'))
      : null;
    if (integrityGuard?.status?.quarantined) this.#enterQuarantine(integrityGuard.status.reason ?? 'Zion integrity quarantine');
  }
  async handle({ nodeId, payload }, socket, transport) {
    await this.#assertIntegrity();
    this.#prune();
    if (payload.type === 'STORE_CHUNK') return this.#acceptPart(nodeId, payload, socket, transport, false);
    if (payload.type === 'GET_CHUNK') {
      if (!SHA256.test(payload.chunkId ?? '') || !TRANSFER_ID.test(payload.requestId ?? '')) throw new Error('Invalid chunk request');
      const bytes = await this.store.get(payload.chunkId);
      const transferId = randomBytes(16).toString('hex');
      const partCount = Math.ceil(bytes.length / this.partBytes);
      for (let partIndex = 0; partIndex < partCount; partIndex++) {
        transport.send(socket, { type: 'CHUNK_DATA', transferId, requestId: payload.requestId, chunkId: payload.chunkId, totalBytes: bytes.length,
          partIndex, partCount, data: bytes.subarray(partIndex * this.partBytes, (partIndex + 1) * this.partBytes).toString('base64') });
      }
      return;
    }
    if (payload.type === 'CHUNK_DATA') return this.#acceptPart(nodeId, payload, socket, transport, true);
    throw new Error('Unsupported storage operation');
  }
  async #acceptPart(nodeId, payload, socket, transport, response) {
    const expectedType = response ? 'CHUNK_DATA' : 'STORE_CHUNK';
    if (payload.type !== expectedType || !TRANSFER_ID.test(payload.transferId ?? '') || !SHA256.test(payload.chunkId ?? '') ||
      !Number.isSafeInteger(payload.totalBytes) || payload.totalBytes < 33 || payload.totalBytes > this.maxChunkBytes ||
      !Number.isSafeInteger(payload.partCount) || payload.partCount < 1 || payload.partCount > Math.ceil(this.maxChunkBytes / this.partBytes) ||
      !Number.isSafeInteger(payload.partIndex) || payload.partIndex < 0 || payload.partIndex >= payload.partCount ||
      typeof payload.data !== 'string' || payload.data.length > this.partBytes * 2 || (response && !TRANSFER_ID.test(payload.requestId ?? ''))) throw new Error('Invalid chunk transfer segment');
    const part = Buffer.from(payload.data, 'base64');
    if (part.length === 0 || part.length > this.partBytes || part.toString('base64') !== payload.data) throw new Error('Invalid base64 chunk segment');
    const transferKey = `${nodeId}:${payload.transferId}:${response ? 'get' : 'put'}`;
    let transfer = this.transfers.get(transferKey);
    if (!transfer) {
      if (this.transfers.size >= this.maxTransfers || this.bufferedBytes + payload.totalBytes > this.maxBufferedBytes) throw new Error('Transfer capacity exceeded');
      if (payload.partCount !== Math.ceil(payload.totalBytes / this.partBytes)) throw new Error('Inconsistent chunk segmentation');
      if (!response) {
        const req = payload.request;
        const requestCheck = validateStoreRequest(req, { now: this.now(), expectedTargetNodeId: this.identity.nodeId,
          expectedChunkId: payload.chunkId, expectedBytes: payload.totalBytes });
        if (!requestCheck.ok) { const error = new Error(`Invalid or expired store request: ${requestCheck.reason}`); error.code = 'REA_INVALID_STORE_REQUEST'; throw error; }
      }
      transfer = { nodeId, chunkId: payload.chunkId, requestId: response ? payload.requestId : undefined, totalBytes: payload.totalBytes, partCount: payload.partCount, parts: new Array(payload.partCount), received: 0, bytes: 0, expiresAt: this.now() + this.transferTtlMs, request: payload.request };
      this.transfers.set(transferKey, transfer); this.bufferedBytes += payload.totalBytes;
    } else if (transfer.chunkId !== payload.chunkId || transfer.totalBytes !== payload.totalBytes || transfer.partCount !== payload.partCount || (response && transfer.requestId !== payload.requestId)) throw new Error('Chunk transfer metadata changed');
    if (transfer.parts[payload.partIndex]) throw new Error('Duplicate chunk transfer segment');
    const expectedLen = payload.partIndex === payload.partCount - 1 ? payload.totalBytes - this.partBytes * (payload.partCount - 1) : this.partBytes;
    if (part.length !== expectedLen) throw new Error('Chunk segment has unexpected length');
    transfer.parts[payload.partIndex] = part; transfer.received++; transfer.bytes += part.length;
    if (transfer.received !== transfer.partCount) return;
    this.transfers.delete(transferKey); this.bufferedBytes -= transfer.totalBytes;
    const complete = Buffer.concat(transfer.parts, transfer.totalBytes);
    if (complete.length !== transfer.totalBytes || createHash('sha256').update(complete).digest('hex') !== transfer.chunkId) throw new Error('Transferred chunk digest mismatch');
    if (response) {
      const key = `${nodeId}:${transfer.requestId}`;
      const pending = this.pendingGets.get(key);
      if (!pending) throw new Error('Unsolicited chunk response');
      if (pending.chunkId !== transfer.chunkId) throw new Error('Chunk response does not match request');
      this.pendingGets.delete(key); clearTimeout(pending.timeout); pending.resolve(Buffer.from(complete)); return;
    }
    const admission = await this.abuseGuard?.reserve(nodeId, complete.length);
    if (admission && !admission.ok) {
      transport.send(socket, { type: 'STORE_REJECTED', requestId: transfer.request?.requestId, chunkId: transfer.chunkId, code: 'FAIR_USE_LIMIT', availableBytes: 0 });
      return;
    }
    let result;
    try { await this.#assertIntegrity(); result = await this.store.put(transfer.chunkId, complete); }
    catch (error) {
      await admission?.release();
      if (error?.code === 'REA_CAPACITY_EXHAUSTED') {
        transport.send(socket, { type: 'STORE_REJECTED', requestId: transfer.request?.requestId, chunkId: transfer.chunkId, code: 'CAPACITY_EXHAUSTED', availableBytes: error.availableBytes ?? 0 });
        return;
      }
      throw error;
    }
    // A successful put() result is not sufficient evidence for a receipt: adapters and
    // filesystems can fail after reporting success. Read back the committed object and
    // verify both its content address and byte count before granting credit or signing.
    try {
      // Both OpaqueReplicaStore ({ id }) and the optional RustStorageAdapter
      // ({ chunkId }) implement the same persistence contract.
      const storedId = result?.id ?? result?.chunkId;
      if (!result || storedId !== transfer.chunkId || result.bytes !== complete.length ||
          typeof this.store.get !== 'function') {
        throw new Error('Storage adapter did not provide verifiable persistence evidence');
      }
      const persisted = await this.store.get(transfer.chunkId);
      if (!Buffer.isBuffer(persisted) || persisted.length !== complete.length ||
          createHash('sha256').update(persisted).digest('hex') !== transfer.chunkId ||
          !persisted.equals(complete)) {
        throw new Error('Persisted replica read-back verification failed');
      }
      await this.#assertIntegrity();
      const verifiedAt = this.now();
      if (verifiedAt > transfer.request.expiresAt) throw new Error('Store request expired before persistence verification completed');
      // Build the signed acknowledgement while the reservation can still be released
      // if signing or request validation fails. It is not sent until commit succeeds.
      var receipt = createStoreReceipt(this.identity, transfer.request, { storedBytes: complete.length, now: verifiedAt });
      await admission?.commit();
    } catch (error) {
      await admission?.release();
      throw error;
    }
    await this.#assertIntegrity();
    transport.send(socket, receipt.payload);
  }
  /** Refresh contribution credit from a fresh local integrity audit, never from peer claims. */
  async refreshVerifiedContribution(fairSharePolicy, { maxEntries = 10_000, batchSize = 128, shouldContinue = null, checkpointPath = null } = {}) {
    await this.#assertIntegrity();
    if (!fairSharePolicy || typeof fairSharePolicy.setVerifiedContributionBytes !== 'function' || typeof this.store.auditInventory !== 'function') {
      throw new TypeError('A fair-share policy and an auditable replica store are required');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid contribution audit entry limit');
    try {
      const inventory = await this.store.auditInventory({ maxEntries, batchSize, shouldContinue, checkpointPath });
      await this.#assertIntegrity();
      if (!Number.isSafeInteger(inventory?.verifiedBytes) || inventory.verifiedBytes < 0) throw new Error('Invalid verified contribution inventory');
      const personalQuotaBytes = fairSharePolicy.setVerifiedContributionBytes(inventory.verifiedBytes);
      return Object.freeze({ ...inventory, personalQuotaBytes });
    } catch (error) {
      // A cooperative pause is not an integrity failure; old evidence remains usable only until its normal TTL.
      if (error?.code !== 'REA_AUDIT_PAUSED') {
        // Failed audits must revoke old credit; stale credit must not survive evidence failure.
        fairSharePolicy.revokeVerifiedContribution?.();
      }
      throw error;
    }
  }

  #enterQuarantine(reason = 'Zion integrity quarantine') {
    // Shed volatile data immediately; never delete persisted user chunks.
    for (const transfer of this.transfers.values()) {
      for (const part of transfer.parts ?? []) if (Buffer.isBuffer(part)) part.fill(0);
    }
    this.transfers.clear();
    this.bufferedBytes = 0;
    this.closePendingGets(reason);
  }

  async #assertIntegrity() {
    if (!this.integrityGuard) return;
    try {
      if (typeof this.integrityGuard.checkHealthy === 'function') return await this.integrityGuard.checkHealthy();
      if (typeof this.integrityGuard.assertHealthy === 'function') return this.integrityGuard.assertHealthy();
      throw new Error('Invalid integrity guard');
    } catch (error) {
      if (error?.code === 'ZION_INTEGRITY_QUARANTINED' || this.integrityGuard.status?.quarantined) this.#enterQuarantine(error.message);
      throw error;
    }
  }

  #prune() {
    const now = this.now();
    for (const [key, transfer] of this.transfers) if (transfer.expiresAt <= now) { this.transfers.delete(key); this.bufferedBytes -= transfer.totalBytes; }
  }

  /** Fetch one chunk from a specific authenticated peer; rejects on timeout or integrity failure. */
  async fetchChunk(transport, socket, peerNodeId, chunkId, { timeoutMs = 10_000 } = {}) {
    await this.#assertIntegrity();
    if (typeof peerNodeId !== 'string' || !SHA256.test(peerNodeId) || !SHA256.test(chunkId ?? '') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError('Invalid chunk fetch request');
    if (!socket || socket.destroyed || !socket.writable) return Promise.reject(new Error('Peer socket is not writable'));
    const requestId = randomBytes(16).toString('hex');
    const key = `${peerNodeId}:${requestId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingGets.delete(key); reject(new Error('Chunk fetch timed out')); }, timeoutMs);
      timeout.unref?.();
      this.pendingGets.set(key, { chunkId, resolve, reject, timeout });
      try { transport.send(socket, { type: 'GET_CHUNK', requestId, chunkId }); }
      catch (error) { clearTimeout(timeout); this.pendingGets.delete(key); reject(error); }
    });
  }

  closePendingGets(reason = 'Storage service closed') {
    for (const pending of this.pendingGets.values()) { clearTimeout(pending.timeout); pending.reject(new Error(reason)); }
    this.pendingGets.clear();
  }

  /** Send one encrypted envelope as bounded signed protocol messages. */
  async sendStoreChunk(transport, socket, envelope, targetNodeId, requestFactory) {
    await this.#assertIntegrity();
    if (!Buffer.isBuffer(envelope) || envelope.length < 33 || envelope.length > this.maxChunkBytes) throw new RangeError('Invalid encrypted chunk size');
    const chunkId = createHash('sha256').update(envelope).digest('hex');
    const request = requestFactory({ chunkId, bytes: envelope.length, targetNodeId });
    if (request.chunkId !== chunkId || request.bytes !== envelope.length || request.targetNodeId !== targetNodeId) throw new Error('Store request does not match chunk');
    const transferId = randomBytes(16).toString('hex'); const partCount = Math.ceil(envelope.length / this.partBytes);
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
      const data = envelope.subarray(partIndex * this.partBytes, (partIndex + 1) * this.partBytes).toString('base64');
      transport.send(socket, { type: 'STORE_CHUNK', transferId, chunkId, totalBytes: envelope.length, partIndex, partCount, data, ...(partIndex === 0 ? { request } : {}) });
    }
    return Object.freeze({ chunkId, bytes: envelope.length, request, transferId });
  }
}
