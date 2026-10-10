/**
 * Conservative local resource governor. This computes an application budget;
 * it does NOT enforce OS-level CPU/memory limits by itself.
 */
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const DEFAULT_HARD_LIMITS = Object.freeze({
  maxCpuPercent: 1,
  maxMemoryMiB: 128,
  maxDiskMiB: 2048,
  maxUploadKiBps: 128,
  maxDownloadKiBps: 512,
  maxConcurrentJobs: 1,
  allowOnBattery: false,
  allowWhenUserActive: false,
  maxTemperatureC: 75,
});

export function validateLimits(limits = {}) {
  const merged = { ...DEFAULT_HARD_LIMITS, ...limits };
  const ranges = {
    maxCpuPercent: [0, 100], maxMemoryMiB: [0, 1_048_576],
    maxDiskMiB: [0, 1_073_741_824], maxUploadKiBps: [0, 10_485_760],
    maxDownloadKiBps: [0, 10_485_760], maxConcurrentJobs: [0, 64],
    maxTemperatureC: [20, 110],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isFinite(merged[key]) || merged[key] < min || merged[key] > max) {
      throw new RangeError(`Invalid hard limit: ${key}`);
    }
  }
  if (typeof merged.allowOnBattery !== 'boolean' || typeof merged.allowWhenUserActive !== 'boolean') {
    throw new TypeError('Boolean safety limits must be booleans');
  }
  return Object.freeze(merged);
}

export class ResourceGovernor {
  constructor({ limits = {}, production = false, enforcementAdapter = null } = {}) {
    this.limits = validateLimits(limits);
    this.production = production;
    this.enforcementAdapter = enforcementAdapter;
    this.lastDecision = null;
  }

  /**
   * Telemetry fields: cpuPercent, memoryPressure (0..1), diskBusy (0..1),
   * networkBusy (0..1), temperatureC, onBattery, userActive, telemetryHealthy.
   * Unknown/unhealthy telemetry fails closed.
   */
  evaluate(t = {}) {
    const healthy = t.telemetryHealthy === true &&
      ['cpuPercent', 'memoryPressure', 'diskBusy', 'networkBusy', 'temperatureC']
        .every(k => Number.isFinite(t[k])) &&
      typeof t.onBattery === 'boolean' && typeof t.userActive === 'boolean' &&
      t.cpuPercent >= 0 && t.cpuPercent <= 100 &&
      ['memoryPressure', 'diskBusy', 'networkBusy'].every(k => t[k] >= 0 && t[k] <= 1) &&
      t.temperatureC >= -20 && t.temperatureC <= 150;
    const enforcementReady = !this.production ||
      (this.enforcementAdapter && this.enforcementAdapter.verified === true && this.enforcementAdapter.complete === true);
    let factor = 0;
    let reasons = [];

    if (!healthy) reasons.push('telemetry-unavailable');
    else if (!enforcementReady) reasons.push('os-enforcement-unverified');
    else {
      factor = 1;
      if (t.temperatureC >= this.limits.maxTemperatureC) { factor = 0; reasons.push('temperature-limit'); }
      if (t.memoryPressure >= 0.90) { factor = 0; reasons.push('memory-pressure-critical'); }
      else if (t.memoryPressure >= 0.75) { factor = Math.min(factor, 0.1); reasons.push('memory-pressure-high'); }
      if (t.cpuPercent >= 90) { factor = 0; reasons.push('host-cpu-critical'); }
      else if (t.cpuPercent >= 75) { factor = Math.min(factor, 0.1); reasons.push('host-cpu-high'); }
      if (t.diskBusy >= 0.90) { factor = 0; reasons.push('disk-busy-critical'); }
      else if (t.diskBusy >= 0.70) { factor = Math.min(factor, 0.1); reasons.push('disk-busy-high'); }
      if (t.networkBusy >= 0.90) { factor = Math.min(factor, 0.1); reasons.push('network-busy-high'); }
      if (t.onBattery && !this.limits.allowOnBattery) { factor = 0; reasons.push('battery-policy'); }
      if (t.userActive && !this.limits.allowWhenUserActive) { factor = 0; reasons.push('user-active-policy'); }
    }

    const scaled = n => Math.floor(n * factor);
    const decision = Object.freeze({
      // A zero owner limit is a hard opt-out, not an enabled worker with a zero budget.
      enabled: factor > 0 && this.limits.maxConcurrentJobs > 0 &&
        this.limits.maxCpuPercent > 0 && this.limits.maxMemoryMiB > 0 && this.limits.maxDiskMiB > 0,
      factor,
      cpuPercentBudget: this.limits.maxCpuPercent * factor,
      memoryMiBBudget: scaled(this.limits.maxMemoryMiB),
      diskMiBBudget: scaled(this.limits.maxDiskMiB),
      uploadKiBps: scaled(this.limits.maxUploadKiBps),
      downloadKiBps: scaled(this.limits.maxDownloadKiBps),
      concurrentJobs: factor > 0 ? Math.min(this.limits.maxConcurrentJobs, factor < 0.2 ? 1 : this.limits.maxConcurrentJobs) : 0,
      reasons,
      sampledAt: Date.now(),
    });
    this.lastDecision = decision;
    return decision;
  }
}
