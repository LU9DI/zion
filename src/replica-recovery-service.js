import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;

/** Attempts retrieval from known peers in order, verifying the content-addressed ciphertext each time. */
export class ReplicaRecoveryService {
  constructor({ transport, storageService, destinationStore = null, maxPeers = 32, requestTimeoutMs = 10_000 } = {}) {
    if (!transport || !storageService || !Number.isSafeInteger(maxPeers) || maxPeers < 1 || maxPeers > 256 ||
      !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) {
      throw new TypeError('Invalid replica recovery configuration');
    }
    this.transport = transport; this.storageService = storageService; this.destinationStore = destinationStore;
    this.maxPeers = maxPeers; this.requestTimeoutMs = requestTimeoutMs;
  }

  async recover({ chunkId, peers } = {}) {
    if (!SHA256.test(chunkId ?? '') || !Array.isArray(peers)) throw new TypeError('Invalid recovery request');
    const seen = new Set(); const candidates = [];
    for (const peer of peers) {
      if (!peer || typeof peer.nodeId !== 'string' || !SHA256.test(peer.nodeId) || peer.nodeId === this.storageService.identity.nodeId ||
        !peer.socket || peer.socket.destroyed || !peer.socket.writable || seen.has(peer.nodeId) ||
        peer.quarantined === true || (peer.integrityStatus !== undefined && peer.integrityStatus !== 'verified')) continue;
      seen.add(peer.nodeId); candidates.push(peer);
      if (candidates.length >= this.maxPeers) break;
    }
    const failures = [];
    for (const peer of candidates) {
      try {
        const envelope = await this.storageService.fetchChunk(this.transport, peer.socket, peer.nodeId, chunkId, { timeoutMs: this.requestTimeoutMs });
        if (createHash('sha256').update(envelope).digest('hex') !== chunkId) throw new Error('Recovered chunk digest mismatch');
        if (this.destinationStore) await this.destinationStore.put(chunkId, envelope);
        return Object.freeze({ ok: true, chunkId, sourceNodeId: peer.nodeId, bytes: envelope.length, envelope: Buffer.from(envelope),
          persistedLocally: Boolean(this.destinationStore), attemptedPeers: failures.length + 1, failures: Object.freeze(failures) });
      } catch (error) {
        failures.push(Object.freeze({ nodeId: peer.nodeId, reason: error?.message === 'Chunk fetch timed out' ? 'timeout' : 'unavailable-or-invalid' }));
      }
    }
    return Object.freeze({ ok: false, chunkId, sourceNodeId: null, bytes: 0, persistedLocally: false,
      attemptedPeers: failures.length, failures: Object.freeze(failures), reason: 'no-verified-replica-available' });
  }
}
