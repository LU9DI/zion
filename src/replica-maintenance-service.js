import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REPAIR_PEERS = 256;

/**
 * Connects the durable catalog, verified recovery, and replication coordinator.
 * Catalog receipts remain historical claims unless an operator/monitor marks a node unavailable.
 */
export class ReplicaMaintenanceService {
  constructor({ catalog, recoveryService, coordinator, sourceStore = null, maxPeers = 64, networkMode = 'legacy', integrityGuard = null } = {}) {
    if (!catalog || !recoveryService || !coordinator || !Number.isSafeInteger(maxPeers) || maxPeers < 1 || maxPeers > MAX_REPAIR_PEERS ||
      !['legacy', 'official'].includes(networkMode) ||
      (integrityGuard !== null && typeof integrityGuard.checkHealthy !== 'function' && typeof integrityGuard.assertHealthy !== 'function')) {
      throw new TypeError('Invalid replica maintenance configuration');
    }
    if (networkMode === 'official' && (!integrityGuard || typeof integrityGuard.checkHealthy !== 'function' ||
      typeof integrityGuard.assertHealthy !== 'function' || !integrityGuard.status || typeof integrityGuard.status !== 'object' ||
      integrityGuard.status.verified !== true || integrityGuard.status.quarantined === true)) {
      throw new Error('Official Zion mode requires a verified IntegrityGuard for replica maintenance');
    }
    this.catalog = catalog;
    this.recoveryService = recoveryService;
    this.coordinator = coordinator;
    this.sourceStore = sourceStore;
    this.maxPeers = maxPeers;
    this.networkMode = networkMode;
    this.integrityGuard = integrityGuard;
  }

  /**
   * Repair a catalog entry already known to be under-replicated.
   * The caller must mark known-dead nodes unavailable before invoking this method.
   */
  async repairChunk({ chunkId, peers } = {}) {
    if (!SHA256.test(chunkId ?? '') || !Array.isArray(peers)) throw new TypeError('Invalid repair request');
    // Re-check the local release integrity at the maintenance boundary, before
    // reading catalog state, contacting peers, or writing additional receipts.
    if (this.networkMode === 'official' || this.integrityGuard) {
      try {
        if (this.integrityGuard.status?.quarantined) throw new Error('integrity-quarantined');
        if (typeof this.integrityGuard.checkHealthy === 'function') await this.integrityGuard.checkHealthy();
        else this.integrityGuard.assertHealthy();
      } catch {
        return Object.freeze({ ok: false, chunkId, repaired: false, underReplicated: true,
          reason: 'local-integrity-not-healthy' });
      }
    }
    const entry = await this.catalog.get(chunkId);
    if (!entry) return Object.freeze({ ok: false, chunkId, reason: 'chunk-not-in-catalog' });

    const existing = new Map(entry.receipts.map(receipt => [receipt.nodeId, { ...receipt, chunkId, storedBytes: entry.bytes }]));
    const missing = Math.max(0, entry.desiredReplicas - existing.size);
    if (missing === 0) return Object.freeze({ ok: true, chunkId, repaired: false, underReplicated: false,
      confirmedReplicas: existing.size, missingReplicas: 0, reason: 'catalog-target-already-met' });

    const candidates = [];
    const seen = new Set();
    for (const peer of peers) {
      if (!peer || !SHA256.test(peer.nodeId ?? '') || seen.has(peer.nodeId) || peer.nodeId === this.coordinator.identity?.nodeId) continue;
      seen.add(peer.nodeId);
      if (!peer.socket || peer.socket.destroyed || !peer.socket.writable) continue;
      candidates.push(peer);
      if (candidates.length >= this.maxPeers) break;
    }

    let envelope;
    if (this.sourceStore) {
      try {
        const local = await this.sourceStore.get(chunkId);
        if (createHash('sha256').update(local).digest('hex') === chunkId) envelope = Buffer.from(local);
      } catch { /* A missing or corrupt local copy is not a valid recovery source. */ }
    }
    let recovery = null;
    if (!envelope) {
      const knownSourcePeers = candidates.filter(peer => existing.has(peer.nodeId));
      recovery = await this.recoveryService.recover({ chunkId, peers: knownSourcePeers });
      if (!recovery.ok) return Object.freeze({ ok: false, chunkId, repaired: false, underReplicated: true,
        confirmedReplicas: existing.size, missingReplicas: missing, reason: 'no-verified-source-for-repair', recovery });
      envelope = recovery.envelope;
    }

    if (!Buffer.isBuffer(envelope) || createHash('sha256').update(envelope).digest('hex') !== chunkId || envelope.length !== entry.bytes) {
      return Object.freeze({ ok: false, chunkId, repaired: false, underReplicated: true,
        confirmedReplicas: existing.size, missingReplicas: missing, reason: 'source-envelope-does-not-match-catalog' });
    }

    const destinations = candidates.filter(peer => !existing.has(peer.nodeId));
    if (destinations.length === 0) return Object.freeze({ ok: false, chunkId, repaired: false, underReplicated: true,
      confirmedReplicas: existing.size, missingReplicas: missing, reason: 'no-new-eligible-destinations' });

    const result = await this.coordinator.replicate({ envelope, peers: destinations, replicaCount: Math.min(missing, destinations.length),
      excludedNodeIds: [...existing.keys()] });
    const merged = new Map(existing);
    for (const receipt of result.receipts) {
      if (receipt.chunkId === chunkId && receipt.storedBytes === entry.bytes && !merged.has(receipt.nodeId)) merged.set(receipt.nodeId, receipt);
    }
    const updated = await this.catalog.recordReplication({ chunkId, bytes: entry.bytes, desiredReplicas: entry.desiredReplicas,
      receipts: [...merged.values()].slice(0, 100) });
    return Object.freeze({ ok: updated.receipts.length >= updated.desiredReplicas, chunkId, repaired: result.receipts.length > 0,
      underReplicated: updated.status !== 'replication-confirmed', confirmedReplicas: updated.receipts.length,
      missingReplicas: Math.max(0, updated.desiredReplicas - updated.receipts.length), source: recovery ? recovery.sourceNodeId : 'local',
      replication: result, catalogEntry: updated });
  }

  /** Record a node as unavailable and return the catalog's affected-chunk count. */
  async markNodeUnavailable(nodeId) {
    if (!SHA256.test(nodeId ?? '')) throw new TypeError('Invalid node id');
    return this.catalog.markNodeUnavailable(nodeId);
  }
}
