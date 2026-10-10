import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleParticipationController } from '../src/idle-participation-controller.js';

test('pauses after inactivity and requests graceful drain without deleting storage', async () => {
  let now = 10_000_000;
  const calls = [];
  const controller = new IdleParticipationController({
    idleAfterMs: 60_000, now: () => now,
    pauseParticipation: async options => calls.push(['pause', options]),
    resumeParticipation: async options => calls.push(['resume', options]),
  });
  const status = await controller.evaluate({ telemetryHealthy: true, lastActivityAt: now - 60_000, pendingOperations: 0 });
  assert.equal(status.state, 'paused');
  assert.equal(status.reason, 'idle-timeout');
  assert.deepEqual(calls[0], ['pause', { reason: 'idle-timeout', drain: true, preserveStorage: true }]);
});

test('waits for in-flight operations before pausing', async () => {
  let now = 500_000;
  let paused = false;
  const controller = new IdleParticipationController({
    idleAfterMs: 60_000, now: () => now,
    pauseParticipation: async () => { paused = true; },
    resumeParticipation: async () => {},
  });
  assert.equal((await controller.evaluate({ telemetryHealthy: true, lastActivityAt: now - 120_000, pendingOperations: 2 })).state, 'active');
  assert.equal(paused, false);
  assert.equal((await controller.evaluate({ telemetryHealthy: true, lastActivityAt: now - 120_000, pendingOperations: 0 })).state, 'paused');
  assert.equal(paused, true);
});

test('unhealthy telemetry fails closed; activity resumes participation', async () => {
  let now = 1_000_000;
  const calls = [];
  const controller = new IdleParticipationController({
    idleAfterMs: 60_000, now: () => now,
    pauseParticipation: async x => calls.push(['pause', x.reason]),
    resumeParticipation: async x => calls.push(['resume', x.reason]),
  });
  assert.equal((await controller.evaluate({ telemetryHealthy: false })).state, 'paused');
  now += 1_000;
  assert.equal((await controller.evaluate({ telemetryHealthy: true, lastActivityAt: now, pendingOperations: 0 })).state, 'active');
  assert.deepEqual(calls, [['pause', 'telemetry-unavailable'], ['resume', 'activity-detected']]);
});

test('uncertain pause state is never resumed before a successful pause retry', async () => {
  let now = 100_000;
  let attempts = 0;
  let resumes = 0;
  const controller = new IdleParticipationController({
    idleAfterMs: 60_000, now: () => now,
    pauseParticipation: async () => { attempts++; if (attempts === 1) throw new Error('disconnect failed'); },
    resumeParticipation: async () => { resumes++; },
  });
  await assert.rejects(controller.evaluate({ telemetryHealthy: true, lastActivityAt: 0, pendingOperations: 0 }), /disconnect failed/);
  now += 1_000;
  assert.equal((await controller.evaluate({ telemetryHealthy: true, lastActivityAt: now, pendingOperations: 0 })).state, 'paused');
  assert.equal(resumes, 0);
  assert.equal(attempts, 2);
});

test('pause hook failure is surfaced and retried on next evaluation', async () => {
  let attempts = 0;
  const controller = new IdleParticipationController({
    idleAfterMs: 60_000, now: () => 100_000,
    pauseParticipation: async () => { attempts++; if (attempts === 1) throw new Error('disconnect failed'); },
    resumeParticipation: async () => {},
  });
  await assert.rejects(controller.evaluate({ telemetryHealthy: true, lastActivityAt: 0, pendingOperations: 0 }), /disconnect failed/);
  assert.equal(controller.getStatus().state, 'pause-failed');
  assert.equal((await controller.evaluate({ telemetryHealthy: true, lastActivityAt: 0, pendingOperations: 0 })).state, 'paused');
  assert.equal(attempts, 2);
});
