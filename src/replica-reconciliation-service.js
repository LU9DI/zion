import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;

/** Checks known replicas without treating an old signed receipt as proof of present availability. */
export class ReplicaReconciliationService {
  constructor({ catalog, transport, storageService, maxEntries = 1000, maxPeersPerChunk = 32, requestTimeoutMs = 10_000, now = () => Date.now() } = {}) {
    if (!catalog || typeof catalog.list !== 'function' || typeof catalog.recordAvailability !== 'function' || !transport || !storageService ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000 ||
      !Number.isSafeInteger(maxPeersPerChunk) || maxPeersPerChunk < 1 || maxPeersPerChunk > 256 ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000 || typeof now !== 'function') {
      throw new TypeError('Invalid replica reconciliation configuration');
    }
    this.catalog = catalog; this.transport = transport; this.storageService = storageService;
    this.maxEntries = maxEntries; this.maxPeersPerChunk = maxPeersPerChunk; this.requestTimeoutMs = requestTimeoutMs; this.now = now;
  }

  async reconcile({ peers, limit = this.maxEntries } = {}) {
    if (!Array.isArray(peers) || !Number.isSafeInteger(limit) || limit < 1 || limit > this.maxEntries) throw new TypeError('Invalid reconciliation request');
    const peerById = new Map();
    for (const peer of peers) {
      if (!peer || !SHA256.test(peer.nodeId ?? '') || peer.nodeId === this.storageService.identity?.nodeId ||
        !peer.socket || peer.socket.destroyed || !peer.socket.writable || peerById.has(peer.nodeId)) continue;
      peerById.set(peer.nodeId, peer);
    }
    const entries = await this.catalog.list({ limit });
    const results = [];
    for (const entry of entries) {
      const candidates = entry.receipts.map(receipt => peerById.get(receipt.nodeId)).filter(Boolean).slice(0, this.maxPeersPerChunk);
      const observations = [];
      for (const peer of candidates) {
        let available = false; let reason = 'unavailable-or-invalid';
        try {
          const envelope = await this.storageService.fetchChunk(this.transport, peer.socket, peer.nodeId, entry.chunkId, { timeoutMs: this.requestTimeoutMs });
          if (Buffer.isBuffer(envelope) && envelope.length === entry.bytes && createHash('sha256').update(envelope).digest('hex') === entry.chunkId) {
            available = true; reason = 'verified';
          }
        } catch (error) { reason = error?.message === 'Chunk fetch timed out' ? 'timeout' : 'unavailable-or-invalid'; }
        observations.push({ nodeId: peer.nodeId, available, checkedAt: this.now(), reason });
      }
      const availability = await this.catalog.recordAvailability({ chunkId: entry.chunkId, observations });
      results.push(Object.freeze({ chunkId: entry.chunkId, historicalReceipts: entry.receipts.length,
        checkedPeers: observations.length, currentlyVerified: observations.filter(item => item.available).length,
        availabilityStatus: availability.status }));
    }
    return Object.freeze({ scanned: results.length, checkedPeers: results.reduce((n, item) => n + item.checkedPeers, 0), results: Object.freeze(results) });
  }
}
