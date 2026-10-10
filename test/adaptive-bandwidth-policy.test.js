import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveBandwidthPolicy } from '../src/adaptive-bandwidth-policy.js';

test('active user caps upload to 10% of measured uplink and configured ceiling', () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 1000, maxDownloadKiBps: 1000 });
  const result = policy.evaluate({ telemetryHealthy: true, userActive: true, networkBusy: 0.1, measuredUploadKiBps: 500, measuredDownloadKiBps: 1000 });
  assert.equal(result.uploadKiBps, 50);
  assert.equal(result.downloadKiBps, 500);
});

test('busy network reduces budgets and missing telemetry fails closed', () => {
  const policy = new AdaptiveBandwidthPolicy();
  const busy = policy.evaluate({ telemetryHealthy: true, userActive: false, networkBusy: 0.95, measuredUploadKiBps: 1000, measuredDownloadKiBps: 1000 });
  assert.equal(busy.uploadKiBps, 0);
  assert.equal(busy.downloadKiBps, 0);
  assert.equal(policy.evaluate({ telemetryHealthy: false }).enabled, false);
});

test('invalid policy fractions are rejected', () => {
  assert.throws(() => new AdaptiveBandwidthPolicy({ activeUploadFraction: 1.1 }), /activeUploadFraction/);
});
