import { PauseStateStore } from './pause-state-store.js';

/**
 * Adds conservative hysteresis around ResourceGovernor decisions.
 * Unsafe decisions take effect immediately; increasing work requires several
 * consecutive healthy samples. This reduces oscillation without delaying stops.
 */
export class AdaptiveResourceController {
  constructor({ governor, healthySamplesToResume = 3, minResumeIntervalMs = 5_000, now = () => Date.now(), pauseStatePath = null } = {}) {
    if (!governor || typeof governor.evaluate !== 'function') throw new TypeError('A resource governor is required');
    if (!Number.isSafeInteger(healthySamplesToResume) || healthySamplesToResume < 1 || healthySamplesToResume > 100) {
      throw new RangeError('healthySamplesToResume must be an integer from 1 to 100');
    }
    if (!Number.isFinite(minResumeIntervalMs) || minResumeIntervalMs < 0 || minResumeIntervalMs > 3_600_000) {
      throw new RangeError('Invalid resume interval');
    }
    this.governor = governor;
    this.healthySamplesToResume = healthySamplesToResume;
    this.minResumeIntervalMs = minResumeIntervalMs;
    if (pauseStatePath !== null && (typeof pauseStatePath !== 'string' || pauseStatePath.trim() === '')) throw new TypeError('pauseStatePath must be a non-empty path or null');
    this.now = now;
    this.pauseStateStore = pauseStatePath === null ? null : new PauseStateStore({ filePath: pauseStatePath });
    this.healthyStreak = 0;
    this.operatorPaused = false;
    this.pauseReason = 'operator-pause';
    if (this.pauseStateStore) {
      try {
        const saved = this.pauseStateStore.load();
        this.operatorPaused = saved.paused;
        if (saved.paused) this.pauseReason = saved.reason;
      } catch {
        // Unknown/corrupt persisted state must never silently enable contribution.
        this.operatorPaused = true;
        this.pauseReason = 'pause-state-unreadable';
      }
    }
    this.lastResumeAt = Number.NEGATIVE_INFINITY;
    this.current = Object.freeze({ enabled: false, factor: 0, reasons: ['not-yet-evaluated'], concurrentJobs: 0 });
  }

  evaluate(telemetry) {
    if (this.operatorPaused) {
      this.healthyStreak = 0;
      this.current = Object.freeze({ enabled: false, factor: 0, cpuPercentBudget: 0,
        memoryMiBBudget: 0, uploadKiBps: 0, downloadKiBps: 0, concurrentJobs: 0,
        reasons: [this.pauseReason] });
      return this.current;
    }
    const candidate = this.governor.evaluate(telemetry);
    if (!candidate.enabled || candidate.factor <= 0) {
      this.healthyStreak = 0;
      this.current = Object.freeze({ ...candidate, enabled: false, factor: 0, cpuPercentBudget: 0,
        memoryMiBBudget: 0, uploadKiBps: 0, downloadKiBps: 0, concurrentJobs: 0,
        reasons: [...new Set([...(candidate.reasons ?? []), 'adaptive-safety-pause'])] });
      return this.current;
    }

    this.healthyStreak += 1;
    const elapsed = this.now() - this.lastResumeAt;
    const mayResume = this.healthyStreak >= this.healthySamplesToResume && elapsed >= this.minResumeIntervalMs;
    if (!this.current.enabled && !mayResume) {
      this.current = Object.freeze({ ...candidate, enabled: false, factor: 0,
        cpuPercentBudget: 0, memoryMiBBudget: 0, uploadKiBps: 0, downloadKiBps: 0, concurrentJobs: 0,
        reasons: [...new Set([...(candidate.reasons ?? []), 'waiting-for-stable-host'])] });
      return this.current;
    }

    if (!this.current.enabled && mayResume) this.lastResumeAt = this.now();
    // Work may be reduced immediately, but a running budget never exceeds the
    // latest candidate or the owner's configured hard limits.
    this.current = Object.freeze({ ...candidate, reasons: [...(candidate.reasons ?? [])] });
    return this.current;
  }

  pause(reason = 'operator-pause') {
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 128) throw new TypeError('Invalid operator pause reason');
    // Persist first; if persistence fails, keep the process paused and surface the error.
    this.operatorPaused = true;
    this.pauseReason = reason;
    if (this.pauseStateStore) {
      try { this.pauseStateStore.savePaused(reason); } catch (error) {
        this.healthyStreak = 0;
        this.current = Object.freeze({ enabled: false, factor: 0, cpuPercentBudget: 0,
          memoryMiBBudget: 0, uploadKiBps: 0, downloadKiBps: 0, concurrentJobs: 0, reasons: [reason] });
        throw error;
      }
    }
    this.healthyStreak = 0;
    this.current = Object.freeze({ enabled: false, factor: 0, cpuPercentBudget: 0,
      memoryMiBBudget: 0, uploadKiBps: 0, downloadKiBps: 0, concurrentJobs: 0, reasons: [reason] });
    return this.current;
  }

  resume() {
    // A durable pause is removed before any in-memory transition can permit work.
    if (this.pauseStateStore) this.pauseStateStore.clear();
    this.operatorPaused = false;
    this.healthyStreak = 0;
    this.current = Object.freeze({ enabled: false, factor: 0, cpuPercentBudget: 0,
      memoryMiBBudget: 0, uploadKiBps: 0, downloadKiBps: 0, concurrentJobs: 0,
      reasons: ['operator-resume-awaiting-stability'] });
    return this.current;
  }
}
