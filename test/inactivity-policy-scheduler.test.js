import test from 'node:test';
import assert from 'node:assert/strict';
import { InactivityPolicyScheduler } from '../src/inactivity-policy-scheduler.js';

function fakeTimer() {
  let callback = null, cleared = false;
  return { setIntervalFn(fn, ms) { callback = fn; this.ms = ms; return { id: 1 }; },
    clearIntervalFn(handle) { assert.equal(handle.id, 1); cleared = true; },
    fire() { callback?.(); }, get cleared() { return cleared; } };
}

test('starts only once, runs immediately, and clears its interval on stop', async () => {
  const timer = fakeTimer(); let evaluations = 0;
  const scheduler = new InactivityPolicyScheduler({ policy: { evaluate: async () => ({ ok: true, n: ++evaluations }), markActivity: async () => ({ ok: true }), snapshot: () => ({}) },
    intervalMs: 1234, setIntervalFn: timer.setIntervalFn.bind(timer), clearIntervalFn: timer.clearIntervalFn.bind(timer) });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(timer.ms, 1234);
  await scheduler.runOnce();
  assert.equal(evaluations, 1);
  assert.equal(await scheduler.stop(), true);
  assert.equal(await scheduler.stop(), false);
  assert.equal(timer.cleared, true);
  assert.equal((await scheduler.runOnce()).status, 'stopped');
  assert.throws(() => scheduler.start(), /stopped permanently/);
});

test('coalesces overlapping evaluations into one in-flight operation', async () => {
  let resolveEvaluation, evaluations = 0;
  const scheduler = new InactivityPolicyScheduler({ policy: { evaluate: () => { evaluations++; return new Promise(resolve => { resolveEvaluation = resolve; }); }, markActivity: async () => ({ ok: true }) } });
  const first = scheduler.runOnce();
  const second = scheduler.runOnce();
  assert.equal(evaluations, 1);
  resolveEvaluation({ ok: true, status: 'done' });
  assert.deepEqual(await first, { ok: true, status: 'done' });
  assert.deepEqual(await second, { ok: true, status: 'done' });
  assert.equal(scheduler.snapshot().evaluating, false);
  scheduler.stop();
});

test('reports bounded evaluation errors without crashing the scheduler', async () => {
  const errors = [];
  const scheduler = new InactivityPolicyScheduler({ policy: { evaluate: async () => { throw new Error('x'.repeat(400)); }, markActivity: async () => ({ ok: true }) }, onError: async error => errors.push(error) });
  const result = await scheduler.runOnce();
  assert.equal(result.status, 'evaluation-error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message.length, 240);
  scheduler.stop();
});

test('serializes verified activity after an in-flight evaluation', async () => {
  let resolveEvaluation, order = [];
  const scheduler = new InactivityPolicyScheduler({ policy: {
    evaluate: () => new Promise(resolve => { resolveEvaluation = value => { order.push('evaluate-finished'); resolve(value); }; }),
    markActivity: async () => { order.push('activity'); return { ok: true }; },
  } });
  const run = scheduler.runOnce();
  const activity = scheduler.recordActivity(123);
  await Promise.resolve();
  assert.deepEqual(order, []);
  resolveEvaluation({ ok: true });
  await run;
  await activity;
  assert.deepEqual(order, ['evaluate-finished', 'activity']);
  scheduler.stop();
});

test('rejects invalid scheduler configuration', () => {
  assert.throws(() => new InactivityPolicyScheduler({ policy: {} }), /Invalid inactivity scheduler/);
  assert.throws(() => new InactivityPolicyScheduler({ policy: { evaluate() {}, markActivity() {} }, intervalMs: 0 }), /Invalid inactivity scheduler/);
});


test('stop clears the timer and waits for an in-flight evaluation to finish', async () => {
  let resolveEvaluation;
  const events = [];
  const timer = fakeTimer();
  const scheduler = new InactivityPolicyScheduler({
    policy: {
      evaluate: () => new Promise(resolve => { events.push('evaluation-started'); resolveEvaluation = value => { events.push('evaluation-finished'); resolve(value); }; }),
      markActivity: async () => ({ ok: true }),
    },
    setIntervalFn: timer.setIntervalFn.bind(timer),
    clearIntervalFn: timer.clearIntervalFn.bind(timer),
  });
  scheduler.start({ runImmediately: false });
  const run = scheduler.runOnce();
  let stopped = false;
  const stop = scheduler.stop().then(result => { stopped = true; return result; });
  await Promise.resolve();
  assert.equal(timer.cleared, true);
  assert.equal(stopped, false, 'stop must wait for the in-flight evaluation');
  assert.deepEqual(events, ['evaluation-started']);
  resolveEvaluation({ ok: true });
  await run;
  assert.equal(await stop, true);
  assert.deepEqual(events, ['evaluation-started', 'evaluation-finished']);
  assert.equal(scheduler.snapshot().evaluating, false);
});


test('stop drains active evaluation even when clearing the timer throws', async () => {
  let resolveEvaluation;
  let timerCleared = false;
  const scheduler = new InactivityPolicyScheduler({
    policy: {
      evaluate: () => new Promise(resolve => { resolveEvaluation = resolve; }),
      markActivity: async () => ({ ok: true }),
    },
    setIntervalFn: () => ({ id: 'timer' }),
    clearIntervalFn: () => { timerCleared = true; throw new Error('timer adapter failed'); },
  });
  scheduler.start({ runImmediately: false });
  const run = scheduler.runOnce();
  let settled = false;
  const stop = scheduler.stop().finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(timerCleared, true);
  assert.equal(settled, false, 'shutdown must drain work despite timer cleanup failure');
  resolveEvaluation({ ok: true });
  await run;
  await assert.rejects(stop, /Inactivity scheduler shutdown was incomplete/);
  assert.equal(scheduler.snapshot().evaluating, false);
  assert.equal(scheduler.snapshot().stopped, true);
});
