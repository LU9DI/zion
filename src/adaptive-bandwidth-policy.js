/**
 * Application-level bandwidth policy. It computes ceilings; it does not
 * shape kernel traffic by itself. Wire these budgets into the actual transfer
 * scheduler/transport and treat missing telemetry as zero contribution.
 */
export class AdaptiveBandwidthPolicy {
  constructor({ maxUploadKiBps = 128, maxDownloadKiBps = 512, activeUploadFraction = 0.10, activeDownloadFraction = 0.50, idleUploadFraction = 1, idleDownloadFraction = 1 } = {}) {
    for (const [key, value] of Object.entries({ maxUploadKiBps, maxDownloadKiBps })) {
      if (!Number.isFinite(value) || value < 0 || value > 10_485_760) throw new RangeError(`Invalid ${key}`);
    }
    for (const [key, value] of Object.entries({ activeUploadFraction, activeDownloadFraction, idleUploadFraction, idleDownloadFraction })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`Invalid ${key}`);
    }
    if (activeUploadFraction > idleUploadFraction || activeDownloadFraction > idleDownloadFraction) throw new RangeError('Active fractions cannot exceed idle fractions');
    this.limits = Object.freeze({ maxUploadKiBps, maxDownloadKiBps, activeUploadFraction, activeDownloadFraction, idleUploadFraction, idleDownloadFraction });
  }

  evaluate({ telemetryHealthy, userActive, networkBusy, measuredUploadKiBps, measuredDownloadKiBps } = {}) {
    const base = { enabled: false, uploadKiBps: 0, downloadKiBps: 0, reason: 'telemetry-unavailable' };
    if (telemetryHealthy !== true || typeof userActive !== 'boolean' ||
        !Number.isFinite(networkBusy) || networkBusy < 0 || networkBusy > 1 ||
        !Number.isFinite(measuredUploadKiBps) || measuredUploadKiBps < 0 ||
        !Number.isFinite(measuredDownloadKiBps) || measuredDownloadKiBps < 0) return Object.freeze(base);

    // On an active host, cap upload to the configured fraction of measured
    // available uplink. Network contention tightens the budget further.
    const uploadFraction = userActive ? this.limits.activeUploadFraction : this.limits.idleUploadFraction;
    const downloadFraction = userActive ? this.limits.activeDownloadFraction : this.limits.idleDownloadFraction;
    const contentionFactor = networkBusy >= 0.9 ? 0 : networkBusy >= 0.7 ? 0.25 : networkBusy >= 0.4 ? 0.5 : 1;
    const uploadKiBps = Math.floor(Math.min(this.limits.maxUploadKiBps, measuredUploadKiBps * uploadFraction) * contentionFactor);
    const downloadKiBps = Math.floor(Math.min(this.limits.maxDownloadKiBps, measuredDownloadKiBps * downloadFraction) * contentionFactor);
    return Object.freeze({ enabled: uploadKiBps > 0 || downloadKiBps > 0, uploadKiBps, downloadKiBps, reason: userActive ? 'interactive-host' : 'idle-host', contentionFactor });
  }
}
