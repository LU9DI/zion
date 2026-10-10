import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InactivityResourcePolicy } from '../src/inactivity-resource-policy.js';

const DAY = 86_400_000;
function fixture(t, { used = 200, capacity = 1000, migrate = async () => false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-inactivity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 10 * DAY;
  let offered = capacity;
  let usage = used;
  const notices = [], calls = [];
  const policy = new InactivityResourcePolicy({
    statePath: join(dir, 'policy.json'), now: () => now,
    options: { warningBeforePauseMs: DAY, pauseAfterMs: 2 * DAY, reductionNoticeBeforeMs: DAY, reduceAfterMs: 4 * DAY, reductionFactor: 0.5 },
    notify: async event => notices.push(event),
    pauseContribution: async reason => calls.push(['pause', reason]),
    resumeContribution: async () => calls.push(['resume']),
    getCapacity: async () => offered,
    setCapacity: async bytes => { offered = bytes; calls.push(['capacity', bytes]); },
    getUsage: async () => usage,
    migrateReplicas: migrate,
  });
  return { policy, notices, calls, get now() { return now; }, set now(v) { now = v; }, get offered() { return offered; }, set usage(v) { usage = v; } };
}

test('notifies before pausing and sends each warning only once', async t => {
  const f = fixture(t);
  f.now += DAY;
  assert.equal((await f.policy.evaluate()).events[0].type, 'pause-warning');
  assert.equal((await f.policy.evaluate()).events.length, 0);
  f.now += DAY;
  assert.equal((await f.policy.evaluate()).status, 'contribution-paused');
  assert.deepEqual(f.calls[0], ['pause', 'inactivity-policy']);
  assert.equal(f.notices.filter(n => n.type === 'pause-warning').length, 1);
});

test('warns before reducing offered capacity and reduces only after the notice deadline', async t => {
  const f = fixture(t);
  f.now += 3 * DAY;
  assert.ok((await f.policy.evaluate()).events.some(event => event.type === 'capacity-reduction-warning'));
  assert.equal(f.offered, 1000);
  f.now += DAY;
  const result = await f.policy.evaluate();
  assert.equal(result.status, 'capacity-reduced');
  assert.equal(f.offered, 500);
  assert.equal(result.dataDeleted, false);
});

test('does not reduce capacity while existing replicas do not fit and migration is unverified', async t => {
  const f = fixture(t, { used: 800 });
  f.now += 4 * DAY;
  const result = await f.policy.evaluate();
  assert.equal(result.status, 'safe-migration-required');
  assert.equal(f.offered, 1000);
  assert.equal(result.dataDeleted, false);
  assert.ok(f.notices.some(n => n.type === 'capacity-reduction-pending'));
});

test('activity resumes contribution and restores original capacity after reduction', async t => {
  const f = fixture(t);
  f.now += 4 * DAY;
  await f.policy.evaluate();
  assert.equal(f.offered, 500);
  await f.policy.markActivity(f.now + 1);
  assert.equal(f.offered, 1000);
  assert.ok(f.calls.some(c => c[0] === 'resume'));
  assert.equal(f.policy.snapshot().pauseApplied, false);
});

test('policy state survives recreation and rejects malformed configuration', async t => {
  const f = fixture(t);
  const statePath = f.policy.statePath;
  f.now += DAY;
  await f.policy.evaluate();
  const restored = new InactivityResourcePolicy({ statePath, now: () => f.now,
    options: { warningBeforePauseMs: DAY, pauseAfterMs: 2 * DAY, reductionNoticeBeforeMs: DAY, reduceAfterMs: 4 * DAY, reductionFactor: 0.5 },
    getCapacity: async () => 1000, getUsage: async () => 200 });
  assert.equal(restored.snapshot().pauseWarningSent, true);
  assert.throws(() => new InactivityResourcePolicy({ statePath, options: { pauseAfterMs: DAY, warningBeforePauseMs: DAY }, getCapacity: async () => 1, getUsage: async () => 0 }), /ordered/);
});

test('reduces capacity only after migration is independently reflected in usage', async t => {
  let f;
  f = fixture(t, { used: 800, migrate: async () => { f.usage = 400; return true; } });
  f.now += 4 * DAY;
  const result = await f.policy.evaluate();
  assert.equal(result.status, 'capacity-reduced');
  assert.equal(f.offered, 500);
  assert.equal(result.dataDeleted, false);
});
