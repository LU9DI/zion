/** Bounded periodic refresh of local contribution evidence. No network input can trigger it. */
export class ContributionAuditScheduler {
  constructor({ storageService, fairSharePolicy, intervalMs = 5 * 60 * 1000, maxEntries = 10_000, batchSize = 128, checkpointPath = null, onResult = null, adaptiveController = null, getTelemetry = null } = {}) {
    if (!storageService || typeof storageService.refreshVerifiedContribution !== 'function' ||
      !fairSharePolicy || typeof fairSharePolicy.revokeVerifiedContribution !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 4096 ||
      typeof onResult !== 'function' && onResult !== null ||
      (adaptiveController === null) !== (getTelemetry === null) ||
      adaptiveController !== null && typeof adaptiveController.evaluate !== 'function' ||
      getTelemetry !== null && typeof getTelemetry !== 'function') {
      throw new TypeError('Invalid contribution audit scheduler configuration');
    }
    if (Number.isSafeInteger(fairSharePolicy.contributionTtlMs) && intervalMs >= fairSharePolicy.contributionTtlMs) {
      throw new RangeError('Audit interval must be shorter than the contribution evidence TTL');
    }
    this.storageService = storageService;
    this.fairSharePolicy = fairSharePolicy;
    this.intervalMs = intervalMs;
    this.maxEntries = maxEntries;
    this.batchSize = batchSize;
    this.checkpointPath = checkpointPath;
    this.onResult = onResult;
    // When supplied, the adaptive gate fails closed on missing telemetry or a paused host.
    this.adaptiveController = adaptiveController;
    this.getTelemetry = getTelemetry;
    this.timer = null;
    this.inFlight = null;
    this.closed = false;
    this.lastResult = null;
  }

  async runOnce() {
    if (this.closed) return Object.freeze({ ok: false, reason: 'scheduler-closed' });
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      if (this.adaptiveController) {
        let decision;
        try {
          const telemetry = await this.getTelemetry();
          decision = this.adaptiveController.evaluate(telemetry);
        } catch (error) {
          const result = Object.freeze({ ok: false, reason: 'resources-not-available', detail: 'telemetry-unavailable', message: String(error?.message ?? 'telemetry unavailable'), completedAt: Date.now() });
          this.lastResult = result;
          try { this.onResult?.(result); } catch { /* Observability only. */ }
          return result;
        }
        if (!decision?.enabled || !(decision.concurrentJobs > 0)) {
          const result = Object.freeze({ ok: false, reason: 'resources-not-available', detail: decision?.reasons ?? ['resource-budget-disabled'], completedAt: Date.now() });
          this.lastResult = result;
          try { this.onResult?.(result); } catch { /* Observability only. */ }
          return result;
        }
      }
      const shouldContinue = this.adaptiveController ? async () => {
        try {
          const telemetry = await this.getTelemetry();
          const decision = this.adaptiveController.evaluate(telemetry);
          return decision?.enabled === true && decision.concurrentJobs > 0;
        } catch {
          return false;
        }
      } : null;
      try {
        const options = { maxEntries: this.maxEntries, batchSize: this.batchSize };
        if (this.checkpointPath !== null) options.checkpointPath = this.checkpointPath;
        if (shouldContinue) options.shouldContinue = shouldContinue;
        const report = await this.storageService.refreshVerifiedContribution(this.fairSharePolicy, options);
        const result = Object.freeze({ ok: true, completedAt: Date.now(), ...report });
        this.lastResult = result;
        try { this.onResult?.(result); } catch { /* Observability callbacks must not affect admission safety. */ }
        return result;
      } catch (error) {
        if (error?.code === 'REA_AUDIT_PAUSED') {
          const result = Object.freeze({ ok: false, reason: 'resources-not-available', detail: 'audit-paused-during-scan', completedAt: Date.now() });
          this.lastResult = result;
          try { this.onResult?.(result); } catch { /* Observability only. */ }
          return result;
        }
        // refreshVerifiedContribution revokes credit on integrity failure; repeat here defensively.
        this.fairSharePolicy.revokeVerifiedContribution();
        const result = Object.freeze({ ok: false, reason: 'audit-failed', message: String(error?.message ?? 'audit failed'), completedAt: Date.now() });
        this.lastResult = result;
        try { this.onResult?.(result); } catch { /* Do not allow callbacks to restore stale credit. */ }
        return result;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  start({ runImmediately = true } = {}) {
    if (this.closed) throw new Error('Contribution audit scheduler is closed');
    if (this.timer) return false;
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.timer.unref?.();
    if (runImmediately) void this.runOnce();
    return true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return true;
  }

  close() {
    this.stop();
    this.closed = true;
  }
}
