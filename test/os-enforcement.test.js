import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LinuxCgroupV2Adapter, getEnforcementStatus } from '../src/os-enforcement.js';
import { ResourceGovernor } from '../src/resource-governor.js';

const healthy = { telemetryHealthy: true, cpuPercent: 5, memoryPressure: 0.1, diskBusy: 0.1, networkBusy: 0.1, temperatureC: 40, onBattery: false, userActive: false };

function fakeFs(controllers = 'cpu memory pids') {
  const files = new Map([['/virtual/cgroup.controllers', controllers]]);
  const dirs = new Set(['/virtual']);
  return {
    files,
    async access(p) { if (!files.has(p) && !dirs.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    async readFile(p) { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
    async mkdir(p) {
      if (dirs.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      dirs.add(p);
      for (const [name, value] of [['cpu.max', '' ], ['memory.max', ''], ['pids.max', ''], ['cgroup.procs', '']]) files.set(path.join(p, name), value);
    },
    async writeFile(p, value) { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); files.set(p, String(value)); },
    async rm(p) { dirs.delete(p); for (const key of [...files.keys()]) if (key.startsWith(`${p}/`)) files.delete(key); },
  };
}

test('platform status never reports full enforcement prematurely', () => {
  for (const platform of ['linux', 'win32', 'darwin', 'freebsd']) {
    const status = getEnforcementStatus(platform);
    assert.equal(status.complete, false);
    assert.equal(status.enforced, false);
    assert.ok(status.missing.length > 0);
  }
});

test('partial OS enforcement cannot enable production contribution', () => {
  const decision = new ResourceGovernor({ production: true, enforcementAdapter: { verified: true, complete: false } }).evaluate(healthy);
  assert.equal(decision.enabled, false);
  assert.ok(decision.reasons.includes('os-enforcement-unverified'));
});

test('complete verified adapter is required for production contribution', () => {
  const decision = new ResourceGovernor({ production: true, enforcementAdapter: { verified: true, complete: true } }).evaluate(healthy);
  assert.equal(decision.enabled, true);
});

test('Linux adapter applies and reads back CPU, memory and PID ceilings before attaching worker', async t => {
  if (process.platform !== 'linux') return t.skip('Linux-specific adapter');
  const fs = fakeFs();
  const adapter = new LinuxCgroupV2Adapter({ root: '/virtual', name: 'test-worker', fs });
  const status = await adapter.initialize({ maxCpuPercent: 1, maxMemoryMiB: 64, maxPids: 3 });
  assert.equal(status.verified, true);
  assert.equal(status.complete, false);
  assert.equal(fs.files.get('/virtual/test-worker/cpu.max'), '1000 100000');
  assert.equal(fs.files.get('/virtual/test-worker/memory.max'), String(64 * 1024 * 1024));
  assert.equal(fs.files.get('/virtual/test-worker/pids.max'), '3');
  await adapter.attachPid(1234);
  assert.equal(fs.files.get('/virtual/test-worker/cgroup.procs'), '1234');
  await adapter.close();
});

test('Linux adapter rejects invalid cgroup names and absent controllers', async t => {
  if (process.platform !== 'linux') return t.skip('Linux-specific adapter');
  assert.throws(() => new LinuxCgroupV2Adapter({ root: '/virtual', name: '../escape', fs: fakeFs() }), TypeError);
  const adapter = new LinuxCgroupV2Adapter({ root: '/virtual', name: 'bad-worker', fs: fakeFs('cpu memory') });
  await assert.rejects(adapter.initialize(), /controllers.*unavailable/);
});
