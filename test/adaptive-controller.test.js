import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceGovernor } from '../src/resource-governor.js';
import { AdaptiveResourceController } from '../src/adaptive-controller.js';

const healthy = extra => ({ telemetryHealthy: true, cpuPercent: 10, memoryPressure: 0.2, diskBusy: 0.1,
  networkBusy: 0.1, temperatureC: 40, onBattery: false, userActive: false, ...extra });

test('requires consecutive healthy samples before starting background work', () => {
  let now = 10_000;
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), healthySamplesToResume: 3, minResumeIntervalMs: 0, now: () => now });
  assert.equal(c.evaluate(healthy()).enabled, false);
  assert.equal(c.evaluate(healthy()).enabled, false);
  assert.equal(c.evaluate(healthy()).enabled, true);
});

test('unsafe telemetry stops work immediately and resets healthy streak', () => {
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), healthySamplesToResume: 2, minResumeIntervalMs: 0 });
  c.evaluate(healthy()); c.evaluate(healthy());
  assert.equal(c.evaluate(healthy({ telemetryHealthy: false })).enabled, false);
  assert.equal(c.evaluate(healthy()).enabled, false);
  assert.equal(c.evaluate(healthy()).enabled, true);
});

test('operator pause stops work immediately', () => {
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), healthySamplesToResume: 1, minResumeIntervalMs: 0 });
  assert.equal(c.evaluate(healthy()).enabled, true);
  assert.equal(c.pause('owner-request').enabled, false);
  assert.deepEqual(c.current.reasons, ['owner-request']);
  assert.equal(c.evaluate(healthy()).enabled, false, 'healthy telemetry must not override explicit owner pause');
  assert.deepEqual(c.current.reasons, ['owner-request']);
  assert.equal(c.resume().enabled, false, 'resume must pass through stability hysteresis');
  assert.equal(c.evaluate(healthy()).enabled, true);
});

test('operator pause reason is validated', () => {
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor() });
  assert.throws(() => c.pause(''), /Invalid operator pause reason/);
  assert.throws(() => c.pause('x'.repeat(129)), /Invalid operator pause reason/);
});

test('resume interval prevents immediate restart after a pause', () => {
  let now = 10_000;
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), healthySamplesToResume: 1, minResumeIntervalMs: 5_000, now: () => now });
  assert.equal(c.evaluate(healthy()).enabled, true);
  c.evaluate(healthy({ cpuPercent: 95 }));
  now += 1_000;
  assert.equal(c.evaluate(healthy()).enabled, false);
  now += 4_000;
  assert.equal(c.evaluate(healthy()).enabled, true);
});
