/**
 * Drives InactivityResourcePolicy on an interval without overlapping evaluations.
 * The host application must wire verified activity signals and real storage callbacks.
 */
export class InactivityPolicyScheduler {
  constructor({ policy, intervalMs = 60 * 60 * 1000, setIntervalFn = setInterval,
    clearIntervalFn = clearInterval, onError = () => {} } = {}) {
    if (!policy || typeof policy.evaluate !== 'function' || typeof policy.markActivity !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || typeof setIntervalFn !== 'function' ||
      typeof clearIntervalFn !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Invalid inactivity scheduler configuration');
    }
    this.policy = policy;
    this.intervalMs = intervalMs;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.onError = onError;
    this.timer = null;
    this.inFlight = null;
    this.closed = false;
    this.lastResult = null;
  }

  start({ runImmediately = true } = {}) {
    if (this.closed) throw new Error('Inactivity scheduler is stopped permanently');
    if (this.timer !== null) return false;
    this.timer = this.setIntervalFn(() => { void this.runOnce(); }, this.intervalMs);
    this.timer?.unref?.();
    if (runImmediately) void this.runOnce();
    return true;
  }

  async runOnce() {
    if (this.closed) return Object.freeze({ ok: false, status: 'stopped' });
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        this.lastResult = await this.policy.evaluate();
        return this.lastResult;
      } catch (error) {
        const safeError = Object.freeze({ name: error?.name || 'Error', message: String(error?.message || 'Inactivity evaluation failed').slice(0, 240) });
        try { await this.onError(safeError); } catch {}
        return Object.freeze({ ok: false, status: 'evaluation-error', error: safeError });
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  async recordActivity(at) {
    if (this.closed) throw new Error('Inactivity scheduler is stopped permanently');
    if (this.inFlight) await this.inFlight;
    if (this.closed) throw new Error('Inactivity scheduler is stopped permanently');
    return this.policy.markActivity(at);
  }

  async stop() {
    const wasRunning = !this.closed;
    const errors = [];
    if (wasRunning) {
      this.closed = true;
      if (this.timer !== null) {
        const timer = this.timer;
        // Detach the timer handle even if the injected timer adapter fails.
        // runOnce() checks closed, so any late callback cannot start new work.
        this.timer = null;
        try { this.clearIntervalFn(timer); } catch (error) { errors.push(error); }
      }
    }
    // Always drain an evaluation that may still be using storage adapters,
    // even when clearing the timer fails.
    if (this.inFlight) {
      try { await this.inFlight; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Inactivity scheduler shutdown was incomplete');
    return wasRunning;
  }

  snapshot() {
    return Object.freeze({ running: this.timer !== null && !this.closed, stopped: this.closed,
      evaluating: this.inFlight !== null, intervalMs: this.intervalMs, lastResult: this.lastResult,
      policy: typeof this.policy.snapshot === 'function' ? this.policy.snapshot() : null });
  }
}
