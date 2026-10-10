/**
 * Coordinates idle pause/resume through explicit runtime hooks.
 * It never deletes storage. Hooks must stop new work and drain in-flight work
 * before disconnecting transports; actual runtime wiring remains the caller's job.
 */
export class IdleParticipationController {
  constructor({
    idleAfterMs = 30 * 60 * 1000,
    now = () => Date.now(),
    pauseParticipation,
    resumeParticipation,
  } = {}) {
    if (!Number.isSafeInteger(idleAfterMs) || idleAfterMs < 60_000 || idleAfterMs > 30 * 24 * 60 * 60 * 1000) {
      throw new RangeError('idleAfterMs must be between one minute and thirty days');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (typeof pauseParticipation !== 'function' || typeof resumeParticipation !== 'function') {
      throw new TypeError('pauseParticipation and resumeParticipation hooks are required');
    }
    this.idleAfterMs = idleAfterMs;
    this.now = now;
    this.pauseParticipation = pauseParticipation;
    this.resumeParticipation = resumeParticipation;
    this.state = 'active';
    this.reason = 'awaiting-telemetry';
    this.transition = Promise.resolve();
  }

  getStatus() {
    return Object.freeze({ state: this.state, reason: this.reason, idleAfterMs: this.idleAfterMs });
  }

  evaluate({ telemetryHealthy, lastActivityAt, pendingOperations = 0 } = {}) {
    const task = this.transition.then(async () => {
      const timestamp = this.now();
      const valid = telemetryHealthy === true && Number.isFinite(lastActivityAt) &&
        lastActivityAt >= 0 && lastActivityAt <= timestamp &&
        Number.isSafeInteger(pendingOperations) && pendingOperations >= 0;
      if (!valid) return this.#pause('telemetry-unavailable');

      const idleForMs = timestamp - lastActivityAt;
      if (idleForMs < this.idleAfterMs) {
        if (this.state !== 'active') {
          await this.resumeParticipation({ reason: 'activity-detected' });
          this.state = 'active';
        }
        this.reason = 'activity-detected';
        return this.getStatus();
      }

      if (pendingOperations > 0) {
        this.reason = 'waiting-for-inflight-operations';
        return this.getStatus();
      }
      return this.#pause('idle-timeout');
    });
    this.transition = task.catch(() => {});
    return task;
  }

  async #pause(reason) {
    if (this.state !== 'paused') {
      this.state = 'pausing';
      this.reason = reason;
      try {
        await this.pauseParticipation({ reason, drain: true, preserveStorage: true });
        this.state = 'paused';
      } catch (error) {
        this.state = 'pause-failed';
        this.reason = 'pause-hook-failed';
        throw error;
      }
    } else {
      this.reason = reason;
    }
    return this.getStatus();
  }
}
