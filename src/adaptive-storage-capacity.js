const CAPACITY_MULTIPLIERS = Object.freeze([
  Object.freeze({ minimumContribution: 0.75, multiplier: 1 }),
  Object.freeze({ minimumContribution: 0.5, multiplier: 0.75 }),
  Object.freeze({ minimumContribution: 0.25, multiplier: 0.5 }),
  Object.freeze({ minimumContribution: 0, multiplier: 0.25 }),
]);

/**
 * Enforces a dynamic admission ceiling over an existing opaque replica store.
 * Lowering the ceiling never evicts existing data; it only refuses new unique
 * replicas until usage falls below the new ceiling. The wrapped store remains
 * responsible for durable writes, integrity, and its own hard quota.
 */
export class AdaptiveStorageCapacity {
  constructor({ store, baseCapacityBytes, minCapacityBytes = 1 } = {}) {
    if (!store || typeof store.put !== 'function' || typeof store.get !== 'function' ||
        typeof store.sizeBytes !== 'function' || typeof store.getCapacityBytes !== 'function') {
      throw new TypeError('store must implement put(), get(), sizeBytes(), and getCapacityBytes()');
    }
    if (!Number.isSafeInteger(baseCapacityBytes) || baseCapacityBytes < 1 || baseCapacityBytes > Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Invalid baseCapacityBytes');
    }
    if (!Number.isSafeInteger(minCapacityBytes) || minCapacityBytes < 1 || minCapacityBytes > baseCapacityBytes) {
      throw new RangeError('Invalid minCapacityBytes');
    }
    this.store = store;
    this.baseCapacityBytes = baseCapacityBytes;
    this.minCapacityBytes = minCapacityBytes;
    this.targetCapacityBytes = baseCapacityBytes;
    this.reason = 'initial-capacity';
  }

  evaluate({ telemetryHealthy, contributionRatio } = {}) {
    if (telemetryHealthy !== true || !Number.isFinite(contributionRatio) ||
        contributionRatio < 0 || contributionRatio > 1) {
      this.targetCapacityBytes = 0;
      this.reason = 'telemetry-unavailable';
      return this.getStatus();
    }
    const tier = CAPACITY_MULTIPLIERS.find(item => contributionRatio >= item.minimumContribution);
    this.targetCapacityBytes = Math.max(this.minCapacityBytes, Math.floor(this.baseCapacityBytes * tier.multiplier));
    this.reason = `contribution-tier-${tier.multiplier}`;
    return this.getStatus();
  }

  getStatus() {
    return Object.freeze({
      baseCapacityBytes: this.baseCapacityBytes,
      targetCapacityBytes: this.targetCapacityBytes,
      reason: this.reason,
      acceptsNewReplicas: this.targetCapacityBytes > 0,
    });
  }

  async put(id, envelope) {
    if (!Buffer.isBuffer(envelope) || envelope.length < 1) throw new TypeError('envelope must be a non-empty Buffer');
    // Preserve idempotent writes of a replica already present, even after a quota reduction.
    try {
      const existing = await this.store.get(id);
      if (existing.equals(envelope)) return await this.store.put(id, envelope);
      throw new Error('Existing replica content mismatch');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (this.targetCapacityBytes <= 0) {
      const error = new Error('New replica admission is disabled until capacity telemetry is healthy');
      error.code = 'ZION_CAPACITY_DISABLED';
      throw error;
    }
    const usedBytes = await this.store.sizeBytes();
    if (usedBytes + envelope.length > this.targetCapacityBytes) {
      const error = new Error('Adaptive storage capacity reached; existing replicas were preserved');
      error.code = 'ZION_ADAPTIVE_CAPACITY_REACHED';
      error.usedBytes = usedBytes;
      error.targetCapacityBytes = this.targetCapacityBytes;
      throw error;
    }
    return this.store.put(id, envelope);
  }

  get(id) { return this.store.get(id); }
  auditInventory(options) {
    if (typeof this.store.auditInventory !== 'function') throw new Error('Underlying store does not support inventory audits');
    return this.store.auditInventory(options);
  }
  sizeBytes() { return this.store.sizeBytes(); }
  getCapacityBytes() { return Promise.resolve(this.targetCapacityBytes); }
}
