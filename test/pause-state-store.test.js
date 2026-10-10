import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceGovernor } from '../src/resource-governor.js';
import { AdaptiveResourceController } from '../src/adaptive-controller.js';

const healthy = () => ({ telemetryHealthy: true, cpuPercent: 10, memoryPressure: 0.2, diskBusy: 0.1,
  networkBusy: 0.1, temperatureC: 40, onBattery: false, userActive: false });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rea-pause-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, filePath: join(dir, 'state', 'pause.json') };
}

test('explicit owner pause survives controller recreation and healthy telemetry', t => {
  const { filePath } = fixture(t);
  const first = new AdaptiveResourceController({ governor: new ResourceGovernor(), pauseStatePath: filePath });
  first.pause('owner-disabled-contribution');
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(persisted.paused, true);
  assert.equal(persisted.reason, 'owner-disabled-contribution');
  const restarted = new AdaptiveResourceController({ governor: new ResourceGovernor(), pauseStatePath: filePath, healthySamplesToResume: 1, minResumeIntervalMs: 0 });
  assert.equal(restarted.evaluate(healthy()).enabled, false);
  assert.deepEqual(restarted.current.reasons, ['owner-disabled-contribution']);
});

test('explicit resume removes durable pause but still waits for stable telemetry', t => {
  const { filePath } = fixture(t);
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), pauseStatePath: filePath, healthySamplesToResume: 2, minResumeIntervalMs: 0 });
  c.pause('owner-request');
  assert.equal(c.resume().enabled, false);
  assert.throws(() => readFileSync(filePath, 'utf8'), { code: 'ENOENT' });
  assert.equal(c.evaluate(healthy()).enabled, false);
  assert.equal(c.evaluate(healthy()).enabled, true);
});

test('corrupt durable pause state fails closed after restart', t => {
  const { dir, filePath } = fixture(t);
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(filePath, '{broken', { mode: 0o600 });
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), pauseStatePath: filePath, healthySamplesToResume: 1, minResumeIntervalMs: 0 });
  assert.equal(c.evaluate(healthy()).enabled, false);
  assert.deepEqual(c.current.reasons, ['pause-state-unreadable']);
  c.resume();
  assert.equal(c.evaluate(healthy()).enabled, true);
});

test('pause remains enforced in memory if durable write fails', t => {
  const { dir } = fixture(t);
  const blocker = join(dir, 'not-a-directory');
  writeFileSync(blocker, 'x');
  const c = new AdaptiveResourceController({ governor: new ResourceGovernor(), pauseStatePath: join(blocker, 'pause.json') });
  assert.throws(() => c.pause('owner-request'));
  assert.equal(c.evaluate(healthy()).enabled, false);
  assert.deepEqual(c.current.reasons, ['owner-request']);
});

test('pause state path must be explicitly configured or null', () => {
  assert.throws(() => new AdaptiveResourceController({ governor: new ResourceGovernor(), pauseStatePath: '' }), /pauseStatePath/);
});
