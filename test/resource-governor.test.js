import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceGovernor } from '../src/resource-governor.js';
const healthy = extra => ({ telemetryHealthy: true, cpuPercent: 10, memoryPressure: 0.2, diskBusy: 0.1, networkBusy: 0.1, temperatureC: 40, onBattery: false, userActive: false, ...extra });

test('healthy idle host receives no more than owner hard limits', () => {
  const g = new ResourceGovernor({ limits: { maxCpuPercent: 2, maxUploadKiBps: 20 } });
  const d = g.evaluate(healthy({}));
  assert.equal(d.cpuPercentBudget, 2); assert.equal(d.uploadKiBps, 20); assert.equal(d.enabled, true);
});
test('missing telemetry fails closed', () => {
  const d = new ResourceGovernor().evaluate({ telemetryHealthy: false });
  assert.equal(d.enabled, false); assert.equal(d.factor, 0);
});
test('critical host CPU stops background work', () => {
  const d = new ResourceGovernor().evaluate(healthy({ cpuPercent: 95 }));
  assert.equal(d.enabled, false); assert.ok(d.reasons.includes('host-cpu-critical'));
});
test('battery policy can force a pause', () => {
  const d = new ResourceGovernor().evaluate(healthy({ onBattery: true }));
  assert.equal(d.enabled, false);
});
test('production mode fails closed without verified OS enforcement', () => {
  const d = new ResourceGovernor({ production: true }).evaluate(healthy({}));
  assert.equal(d.enabled, false); assert.ok(d.reasons.includes('os-enforcement-unverified'));
});
test('invalid owner limits are rejected', () => {
  assert.throws(() => new ResourceGovernor({ limits: { maxCpuPercent: 101 } }), RangeError);
});
test('user activity pauses contribution by default', () => {
  const d = new ResourceGovernor().evaluate(healthy({ userActive: true }));
  assert.equal(d.enabled, false);
  assert.ok(d.reasons.includes('user-active-policy'));
});
test('invalid or incomplete telemetry fails closed', () => {
  const d = new ResourceGovernor().evaluate(healthy({ memoryPressure: 4 }));
  assert.equal(d.enabled, false);
  assert.ok(d.reasons.includes('telemetry-unavailable'));
});
test('memory budget scales down under host pressure', () => {
  const d = new ResourceGovernor({ limits: { maxMemoryMiB: 100 } }).evaluate(healthy({ memoryPressure: 0.8 }));
  assert.equal(d.memoryMiBBudget, 10);
});
