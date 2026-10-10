import { createHash } from 'node:crypto';
import { createStoreRequest, ReplicaReceiptTracker } from './replication-receipts.js';
import { planReplicas } from './replica-scheduler.js';

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

/** Coordinates one bounded replication round. A receipt is an authenticated claim, not proof of continued availability. */
export class ReplicationCoordinator {
  constructor({ identity, transport, storageService, tracker = new ReplicaReceiptTracker(), requestTimeoutMs = 15_000,
    maxChunkBytes = MAX_CHUNK_BYTES, fairSharePolicy = null, catalog = null, now = () => Date.now() } = {}) {
    if (!identity?.nodeId || !transport || !storageService || !tracker || typeof now !== 'function' ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000 ||
      !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 33) throw new TypeError('Invalid replication coordinator configuration');
    this.identity = identity; this.transport = transport; this.storageService = storageService;
    if (fairSharePolicy !== null && typeof fairSharePolicy.reserve !== 'function') throw new TypeError('Invalid fair-share policy');
    if (catalog !== null && typeof catalog.recordReplication !== 'function') throw new TypeError('Invalid replica catalog');
    this.tracker = tracker; this.requestTimeoutMs = requestTimeoutMs; this.maxChunkBytes = maxChunkBytes; this.fairSharePolicy = fairSharePolicy; this.catalog = catalog; this.now = now;
    this.waiting = new Map();
  }

  /** Route authenticated incoming protocol messages from PeerTransport.onMessage here. */
  async handleMessage(message, socket) {
    if (message?.payload?.type === 'STORE_REJECTED') {
      const payload = message.payload;
      if (!/^[a-f0-9]{32}$/.test(payload.requestId ?? '') || !/^[a-f0-9]{64}$/.test(payload.chunkId ?? '') || !['CAPACITY_EXHAUSTED', 'FAIR_USE_LIMIT'].includes(payload.code) || !Number.isSafeInteger(payload.availableBytes) || payload.availableBytes < 0) return { ok: false, reason: 'invalid-capacity-rejection' };
      const waiter = this.waiting.get(payload.requestId);
      if (!waiter || waiter.nodeId !== message.nodeId || waiter.chunkId !== payload.chunkId) return { ok: false, reason: 'unsolicited-capacity-rejection' };
      this.waiting.delete(payload.requestId);
      waiter.reject(Object.assign(new Error(payload.code === 'CAPACITY_EXHAUSTED' ? 'Target replica capacity exhausted' : 'Target peer fair-use limit reached'), { code: payload.code, availableBytes: payload.availableBytes }));
      return { ok: true, reason: payload.code === 'CAPACITY_EXHAUSTED' ? 'capacity-exhausted' : 'fair-use-limit' };
    }
    if (message?.payload?.type === 'STORE_RECEIPT') {
      const result = this.tracker.accept(message.envelope);
      if (result.ok) {
        const waiter = this.waiting.get(result.receipt.requestId);
        if (waiter) { this.waiting.delete(result.receipt.requestId); waiter.resolve(result.receipt); }
      }
      return result;
    }
    if (message?.payload?.type === 'CHUNK_DATA') return this.storageService.handle(message, socket, this.transport);
    return { ok: false, reason: 'unsupported-coordinator-message' };
  }

  async replicate({ envelope, peers, replicaCount = 3, excludedNodeIds = [], personalStoredBytes = 0 } = {}) {
    if (!Buffer.isBuffer(envelope) || envelope.length < 33 || envelope.length > this.maxChunkBytes) throw new RangeError('Invalid encrypted chunk envelope');
    if (!Array.isArray(peers) || !Number.isSafeInteger(replicaCount) || replicaCount < 1 || replicaCount > 100) throw new TypeError('Invalid replication request');
    let reservation = null;
    if (this.fairSharePolicy) {
      const admission = this.fairSharePolicy.reserve({ ownerId: this.identity.nodeId, bytes: envelope.length, personalStoredBytes });
      if (!admission.ok) return Object.freeze({ chunkId: createHash('sha256').update(envelope).digest('hex'), desiredReplicas: replicaCount, attempted: 0, receipts: Object.freeze([]), failures: Object.freeze([{ nodeId: null, reason: `fair-share:${admission.reason}` }]), confirmedReplicas: 0, underReplicated: true, missingReplicas: replicaCount, rejected: true, rejectionReason: admission.reason, quotaBytes: admission.quotaBytes });
      reservation = admission.reservation;
    }
    let result;
    try {
      result = await this.#replicateUnchecked({ envelope, peers, replicaCount, excludedNodeIds });
    } catch (error) { reservation?.release(); throw error; }

    // Remote storage may already have succeeded; never release its quota reservation
    // merely because local metadata persistence subsequently fails.
    if (reservation) { if (result.confirmedReplicas > 0) reservation.commit(); else reservation.release(); }
    if (this.catalog) {
      try {
        const catalogRecord = await this.catalog.recordReplication({
          chunkId: result.chunkId, bytes: envelope.length, desiredReplicas: replicaCount, receipts: result.receipts
        });
        return Object.freeze({ ...result, catalogPersisted: true, catalogRecord });
      } catch (cause) {
        const error = new Error('Replication outcome could not be durably recorded in the local catalog', { cause });
        error.code = 'REA_CATALOG_PERSIST_FAILED';
        error.replicationResult = result;
        throw error;
      }
    }
    return result;
  }

  async #replicateUnchecked({ envelope, peers, replicaCount = 3, excludedNodeIds = [] } = {}) {
    const chunkId = createHash('sha256').update(envelope).digest('hex');
    const peerById = new Map();
    for (const peer of peers) {
      if (!peer || typeof peer.nodeId !== 'string' || peer.nodeId === this.identity.nodeId || !peer.socket || peer.socket.destroyed) continue;
      if (peerById.has(peer.nodeId)) continue;
      peerById.set(peer.nodeId, peer);
    }
    const nodes = [...peerById.values()].map(peer => ({
      id: peer.nodeId, online: peer.online !== false, acceptingStorage: peer.acceptingStorage !== false,
      quarantined: peer.quarantined === true, integrityStatus: peer.integrityStatus,
      availableBytes: Number.isFinite(peer.availableBytes) ? peer.availableBytes : 0,
      resourceBudget: { enabled: peer.resourceBudget?.enabled === true },
      failureDomain: typeof peer.failureDomain === 'string' && peer.failureDomain ? peer.failureDomain : peer.nodeId
    }));
    // Rank the full eligible pool, not only the first replicaCount peers, so a
    // capacity rejection can be routed to a different failure domain.
    const plan = planReplicas({ chunkId, nodes, replicaCount: Math.max(1, nodes.length), excludedNodeIds: [...excludedNodeIds, this.identity.nodeId] });
    const ranked = plan.placements.map(p => peerById.get(p.nodeId)).filter(Boolean);
    const firstWave = ranked.slice(0, replicaCount);
    const fallback = ranked.slice(replicaCount);
    const outcomes = await Promise.all(firstWave.map(peer => this.#sendOne(peer, envelope, chunkId)));
    const receipts = outcomes.filter(x => x.ok).map(x => x.receipt);
    const failures = outcomes.filter(x => !x.ok).map(x => ({ nodeId: x.nodeId, reason: x.reason }));
    let attempted = firstWave.length;
    // Try alternate eligible failure domains only when the first wave failed.
    // The loop is intentionally bounded by the supplied peer list and target count.
    for (const peer of fallback) {
      if (receipts.length >= replicaCount) break;
      const outcome = await this.#sendOne(peer, envelope, chunkId);
      attempted++;
      if (outcome.ok) receipts.push(outcome.receipt);
      else failures.push({ nodeId: outcome.nodeId, reason: outcome.reason });
    }
    return Object.freeze({ chunkId, desiredReplicas: replicaCount, attempted, receipts: Object.freeze(receipts),
      failures: Object.freeze(failures), confirmedReplicas: receipts.length, underReplicated: receipts.length < replicaCount,
      missingReplicas: Math.max(0, replicaCount - receipts.length) });
  }

  async #sendOne(peer, envelope, chunkId) {
    let request;
    try {
      request = createStoreRequest({ chunkId, bytes: envelope.length, targetNodeId: peer.nodeId, now: this.now(), ttlMs: this.requestTimeoutMs });
      this.tracker.register(request);
      let resolveWaiter;
      const receiptPromise = new Promise((resolve, reject) => {
        resolveWaiter = { resolve, reject, nodeId: peer.nodeId, chunkId };
        this.waiting.set(request.requestId, resolveWaiter);
      });
      const timeout = setTimeout(() => {
        const waiter = this.waiting.get(request.requestId);
        if (waiter) { this.waiting.delete(request.requestId); this.tracker.pending.delete(request.requestId); waiter.reject(new Error('Receipt timeout')); }
      }, this.requestTimeoutMs);
      timeout.unref?.();
      try {
        await this.storageService.sendStoreChunk(this.transport, peer.socket, envelope, peer.nodeId, () => request);
        const receipt = await receiptPromise;
        clearTimeout(timeout);
        return { ok: true, nodeId: peer.nodeId, receipt };
      } catch (error) {
        clearTimeout(timeout); this.waiting.delete(request.requestId); this.tracker.pending.delete(request.requestId);
        return { ok: false, nodeId: peer.nodeId, reason: error?.code === 'CAPACITY_EXHAUSTED' ? 'capacity-exhausted' : error?.code === 'FAIR_USE_LIMIT' ? 'fair-use-limit' : error?.message === 'Receipt timeout' ? 'receipt-timeout' : 'send-or-receipt-failed' };
      }
    } catch (error) {
      if (request) this.tracker.pending.delete(request.requestId);
      return { ok: false, nodeId: peer.nodeId, reason: 'request-rejected' };
    }
  }
}
