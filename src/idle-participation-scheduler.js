/**
 * Periodically evaluates verified host-idle telemetry without overlapping runs.
 * The scheduler is lifecycle-managed by OfficialNodeBootstrap when supplied.
 */
export class IdleParticipationScheduler {
  constructor({ controller, getTelemetry, intervalMs = 60_000, setIntervalFn = setInterval,
    clearIntervalFn = clearInterval, onError = () => {} } = {}) {
    if (!controller || typeof controller.evaluate !== 'function' || typeof getTelemetry !== 'function' ||
        !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
        typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function' || typeof onError !== 'function') {
      throw new TypeError('Invalid idle participation scheduler configuration');
    }
    this.controller = controller;
    this.getTelemetry = getTelemetry;
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
    if (this.closed) throw new Error('Idle participation scheduler is stopped permanently');
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
        let telemetry;
        try { telemetry = await this.getTelemetry(); } catch { telemetry = null; }
        this.lastResult = await this.controller.evaluate(telemetry ?? {});
        return this.lastResult;
      } catch (error) {
        const safeError = Object.freeze({ name: error?.name || 'Error',
          message: String(error?.message || 'Idle participation evaluation failed').slice(0, 240) });
        try { await this.onError(safeError); } catch {}
        return Object.freeze({ ok: false, status: 'evaluation-error', error: safeError });
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  async stop() {
    const wasRunning = !this.closed;
    const errors = [];
    if (wasRunning) {
      this.closed = true;
      if (this.timer !== null) {
        const timer = this.timer;
        this.timer = null;
        try { this.clearIntervalFn(timer); } catch (error) { errors.push(error); }
      }
    }
    // Drain telemetry/controller work before bootstrap shuts down storage,
    // even if the injected timer adapter failed to clear its handle.
    if (this.inFlight) {
      try { await this.inFlight; } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Idle participation scheduler shutdown was incomplete');
    return wasRunning;
  }

  snapshot() {
    return Object.freeze({ running: this.timer !== null && !this.closed, stopped: this.closed,
      evaluating: this.inFlight !== null, intervalMs: this.intervalMs, lastResult: this.lastResult });
  }
}
