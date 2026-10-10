import { randomBytes } from 'node:crypto';
import { signPeerMessage, verifyPeerMessage } from './peer-security.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^[a-f0-9]{32}$/;

const STORE_REQUEST_KEYS = new Set(['type', 'requestId', 'chunkId', 'bytes', 'targetNodeId', 'createdAt', 'expiresAt']);

/** Validate the complete request commitment at the storage boundary, not just its envelope shape. */
export function validateStoreRequest(request, { now = Date.now(), maxTtlMs = 10 * 60_000, maxClockSkewMs = 120_000,
  expectedTargetNodeId, expectedChunkId, expectedBytes } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).length !== STORE_REQUEST_KEYS.size || Object.keys(request).some(key => !STORE_REQUEST_KEYS.has(key))) return fail('invalid-request-fields');
  if (request.type !== 'STORE_REQUEST' || !REQUEST_ID.test(request.requestId ?? '') || !SHA256_HEX.test(request.chunkId ?? '') ||
      !SHA256_HEX.test(request.targetNodeId ?? '')) return fail('invalid-request-identity');
  if (!Number.isSafeInteger(request.bytes) || request.bytes < 33 || request.bytes > 64 * 1024 * 1024) return fail('invalid-request-size');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(request.createdAt) || !Number.isSafeInteger(request.expiresAt) ||
      request.createdAt < 0 || request.expiresAt < request.createdAt || request.createdAt > now + maxClockSkewMs ||
      request.expiresAt < now || request.expiresAt - request.createdAt > maxTtlMs) return fail('invalid-request-time-window');
  if (expectedTargetNodeId !== undefined && request.targetNodeId !== expectedTargetNodeId) return fail('wrong-request-target');
  if (expectedChunkId !== undefined && request.chunkId !== expectedChunkId) return fail('wrong-request-chunk');
  if (expectedBytes !== undefined && request.bytes !== expectedBytes) return fail('wrong-request-size');
  return { ok: true };
}

/** Create an unpredictable request identifier to bind a receipt to one store attempt. */
export function createStoreRequest({ chunkId, bytes, targetNodeId, now = Date.now(), ttlMs = 120_000 } = {}) {
  if (!SHA256_HEX.test(chunkId ?? '')) throw new TypeError('Invalid chunk id');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1024 * 1024) throw new RangeError('Invalid stored byte count');
  if (typeof targetNodeId !== 'string' || !SHA256_HEX.test(targetNodeId)) throw new TypeError('Invalid target node id');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 10 * 60_000) throw new RangeError('Invalid request time limits');
  return Object.freeze({ type: 'STORE_REQUEST', requestId: randomBytes(16).toString('hex'), chunkId, bytes, targetNodeId, createdAt: now, expiresAt: now + ttlMs });
}

/** A receiving node signs an acknowledgement only after its handler has completed local storage. */
export function createStoreReceipt(identity, request, { storedBytes, now = Date.now() } = {}) {
  const requestCheck = validateStoreRequest(request, { now, expectedTargetNodeId: identity?.nodeId });
  if (!requestCheck.ok) throw new TypeError(`Invalid store request: ${requestCheck.reason}`);
  if (!Number.isSafeInteger(storedBytes) || storedBytes !== request.bytes) throw new RangeError('Stored byte count does not match request');
  if (!Number.isSafeInteger(now) || now > request.expiresAt || now < request.createdAt) throw new Error('Store request is outside its validity window');
  return signPeerMessage(identity, { type: 'STORE_RECEIPT', requestId: request.requestId, chunkId: request.chunkId, storedBytes, storedAt: now }, { now });
}

/**
 * Stateless verification of a signed storage receipt against its original request.
 * This proves that the target identity signed a matching acknowledgement; it does not
 * prove that the peer still retains the bytes or will remain available.
 */
export function verifyStoreReceipt(message, request) {
  const fail = reason => ({ ok: false, reason });
  const envelopeKeys = ['version', 'nodeId', 'timestamp', 'nonce', 'payload', 'publicKeyPem', 'signature'];
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      Object.keys(message).length !== envelopeKeys.length || Object.keys(message).some(key => !envelopeKeys.includes(key))) {
    return fail('invalid-receipt-envelope');
  }
  // Historical receipts must remain independently verifiable after their original freshness
  // window. Freshness/replay protection belongs to ReplicaReceiptTracker.accept(), not here.
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) return fail('invalid-receipt-timestamp');
  const checked = verifyPeerMessage(message, { now: message.timestamp, maxClockSkewMs: 0 });
  if (!checked.ok) return checked;
  const payload = checked.payload;
  const keys = ['type', 'requestId', 'chunkId', 'storedBytes', 'storedAt'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== keys.length || Object.keys(payload).some(key => !keys.includes(key)) ||
      payload.type !== 'STORE_RECEIPT' || !REQUEST_ID.test(payload.requestId ?? '') ||
      !SHA256_HEX.test(payload.chunkId ?? '') || !Number.isSafeInteger(payload.storedBytes) ||
      payload.storedBytes < 1 || !Number.isSafeInteger(payload.storedAt)) return fail('invalid-receipt');
  if (!request || payload.requestId !== request.requestId) return fail('receipt-request-mismatch');
  if (message.timestamp !== payload.storedAt) return fail('receipt-timestamp-mismatch');
  const requestCheck = validateStoreRequest(request, {
    now: payload.storedAt,
    expectedTargetNodeId: checked.nodeId,
    expectedChunkId: payload.chunkId,
    expectedBytes: payload.storedBytes,
  });
  if (!requestCheck.ok) return fail(requestCheck.reason);
  if (payload.storedAt < request.createdAt || payload.storedAt > request.expiresAt) return fail('receipt-outside-request-window');
  return { ok: true, nodeId: checked.nodeId, receipt: Object.freeze({ ...payload }) };
}

/**
 * Tracks signed acknowledgements, not cryptographic proofs of durable storage.
 * Callers must only issue receipts after local persistence and integrity verification.
 */
export class ReplicaReceiptTracker {
  constructor({ now = () => Date.now(), maxPending = 10_000, maxReceiptsPerChunk = 100, maxClockSkewMs = 120_000 } = {}) {
    if (typeof now !== 'function' || !Number.isSafeInteger(maxPending) || maxPending < 1 || !Number.isSafeInteger(maxReceiptsPerChunk) || maxReceiptsPerChunk < 1 || !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) throw new RangeError('Invalid receipt tracker limits');
    this.now = now; this.maxPending = maxPending; this.maxReceiptsPerChunk = maxReceiptsPerChunk; this.maxClockSkewMs = maxClockSkewMs;
    this.pending = new Map(); this.receipts = new Map();
  }

  register(request) {
    const now = this.now();
    const requestCheck = validateStoreRequest(request, { now, maxTtlMs: 10 * 60_000, expectedBytes: request?.bytes });
    if (!requestCheck.ok) throw new TypeError(`Invalid or expired store request: ${requestCheck.reason}`);
    this.#prune(now);
    if (this.pending.size >= this.maxPending || this.pending.has(request.requestId)) throw new Error('Pending request capacity reached or duplicate request');
    this.pending.set(request.requestId, Object.freeze({ ...request }));
  }

  accept(message) {
    const now = this.now();
    this.#prune(now);
    const checked = verifyPeerMessage(message, { now, maxClockSkewMs: this.maxClockSkewMs });
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const p = checked.payload;
    if (p.type !== 'STORE_RECEIPT' || !REQUEST_ID.test(p.requestId ?? '') || !SHA256_HEX.test(p.chunkId ?? '') || !Number.isSafeInteger(p.storedBytes) || p.storedBytes < 1 || !Number.isSafeInteger(p.storedAt)) return { ok: false, reason: 'invalid-receipt' };
    const request = this.pending.get(p.requestId);
    if (!request) return { ok: false, reason: 'unknown-or-consumed-request' };
    if (request.expiresAt < now) { this.pending.delete(p.requestId); return { ok: false, reason: 'expired-request' }; }
    if (checked.nodeId !== request.targetNodeId) return { ok: false, reason: 'unexpected-node' };
    if (p.chunkId !== request.chunkId || p.storedBytes !== request.bytes || p.storedAt < request.createdAt || p.storedAt > request.expiresAt) return { ok: false, reason: 'receipt-does-not-match-request' };
    const list = this.receipts.get(request.chunkId) ?? [];
    if (list.some(r => r.nodeId === checked.nodeId)) return { ok: false, reason: 'duplicate-node-receipt' };
    if (list.length >= this.maxReceiptsPerChunk) return { ok: false, reason: 'receipt-capacity-reached' };
    const receipt = Object.freeze({ chunkId: request.chunkId, nodeId: checked.nodeId, storedBytes: p.storedBytes, storedAt: p.storedAt, requestId: p.requestId, acceptedAt: now });
    list.push(receipt); this.receipts.set(request.chunkId, list); this.pending.delete(p.requestId);
    return { ok: true, receipt };
  }

  confirmedNodeIds(chunkId) { return Object.freeze((this.receipts.get(chunkId) ?? []).map(r => r.nodeId)); }
  confirmedCount(chunkId) { return (this.receipts.get(chunkId) ?? []).length; }
  isFullyReplicated(chunkId, desiredReplicas = 3) {
    if (!SHA256_HEX.test(chunkId ?? '') || !Number.isSafeInteger(desiredReplicas) || desiredReplicas < 1) throw new TypeError('Invalid replication query');
    return this.confirmedCount(chunkId) >= desiredReplicas;
  }

  #prune(now) {
    for (const [id, request] of this.pending) if (request.expiresAt < now) this.pending.delete(id);
  }
}
