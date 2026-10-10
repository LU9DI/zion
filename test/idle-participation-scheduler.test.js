import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleParticipationScheduler } from '../src/idle-participation-scheduler.js';

function fakeTimer() {
  let callback;
  return {
    setIntervalFn(fn, ms) { callback = fn; this.ms = ms; return { id: 7 }; },
    clearIntervalFn(handle) { assert.equal(handle.id, 7); this.cleared = true; },
    fire() { callback?.(); },
    cleared: false,
  };
}

test('starts once, schedules evaluations, and drains before stop returns', async () => {
  const timer = fakeTimer();
  let resolveEval, calls = 0;
  const scheduler = new IdleParticipationScheduler({
    controller: { evaluate: () => { calls++; return new Promise(resolve => { resolveEval = resolve; }); } },
    getTelemetry: async () => ({ telemetryHealthy: true, lastActivityAt: 1, pendingOperations: 0 }),
    intervalMs: 1234, setIntervalFn: timer.setIntervalFn.bind(timer), clearIntervalFn: timer.clearIntervalFn.bind(timer),
  });
  assert.equal(scheduler.start({ runImmediately: false }), true);
  assert.equal(scheduler.start(), false);
  assert.equal(timer.ms, 1234);
  timer.fire();
  const stopping = scheduler.stop();
  assert.equal(timer.cleared, true);
  resolveEval({ state: 'paused' });
  await stopping;
  assert.equal(calls, 1);
  assert.equal(scheduler.snapshot().stopped, true);
  assert.equal((await scheduler.runOnce()).status, 'stopped');
});

test('coalesces evaluations and fails closed when telemetry cannot be read', async () => {
  const results = [];
  const scheduler = new IdleParticipationScheduler({
    controller: { evaluate: async telemetry => { results.push(telemetry); return { state: telemetry.telemetryHealthy ? 'active' : 'paused' }; } },
    getTelemetry: async () => { throw new Error('sensor unavailable'); },
  });
  const a = scheduler.runOnce(), b = scheduler.runOnce();
  assert.deepEqual(await a, { state: 'paused' });
  assert.deepEqual(await b, { state: 'paused' });
  assert.deepEqual(results, [{}]);
  await scheduler.stop();
});

test('reports bounded hook failures without terminating future scheduling', async () => {
  const errors = [];
  let calls = 0;
  const scheduler = new IdleParticipationScheduler({
    controller: { evaluate: async () => { calls++; if (calls === 1) throw new Error('x'.repeat(400)); return { state: 'active' }; } },
    getTelemetry: async () => ({}), onError: async error => errors.push(error),
  });
  const first = await scheduler.runOnce(), second = await scheduler.runOnce();
  assert.equal(first.status, 'evaluation-error');
  assert.equal(errors[0].message.length, 240);
  assert.deepEqual(second, { state: 'active' });
  await scheduler.stop();
});
