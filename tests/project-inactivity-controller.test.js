import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectInactivityController, PROJECT_INACTIVITY_POLICY } from '../src/project-inactivity-controller.js';

const DAY = 86_400_000;

function harness({ lastActivity = 0, lifecycleStatus = 'active', leases = [{ leaseId: 'lease-1', reservedBytes: 1024 }] } = {}) {
  const state = {
    projectId: 'project-1',
    ownerId: 'owner-1',
    lifecycleStatus,
    lastMeaningfulActivityAt: new Date(lastActivity).toISOString(),
  };
  const calls = [];
  const repository = {
    async withProjectLock(_projectId, fn) {
      const tx = {
        async getProject() { return { ...state }; },
        async recordActivity(event) {
          if (calls.some(x => x.type === 'activity' && x.event.idempotencyKey === event.idempotencyKey)) return false;
          calls.push({ type: 'activity', event });
          return true;
        },
        async updateLastMeaningfulActivity(_id, at) {
          state.lastMeaningfulActivityAt = new Date(at).toISOString();
        },
        async pauseProject() { state.lifecycleStatus = 'paused'; calls.push({ type: 'pause' }); },
        async markStorageReleasePending() { state.lifecycleStatus = 'storage_release_pending'; calls.push({ type: 'pending' }); },
        async cancelStorageReleasePending() { state.lifecycleStatus = 'paused'; calls.push({ type: 'cancel-pending' }); },
        async listLiveStorageLeases() { return leases.map(x => ({ ...x })); },
        async markStorageLeasesReleased(_id, ids) { calls.push({ type: 'leases-released', ids }); },
        async markProjectStorageReleased() { state.lifecycleStatus = 'storage_released'; },
        async recordResourceEvent(event) { calls.push({ type: 'event', event }); },
      };
      return fn(tx);
    },
  };
  let relocate = true;
  let release = true;
  const storage = {
    async relocateAndVerify() { calls.push({ type: 'relocate' }); return relocate; },
    async releaseCapacity() { calls.push({ type: 'release-capacity' }); return release; },
  };
  let now = 0;
  const controller = new ProjectInactivityController({
    repository, storage, now: () => now, id: (() => { let n = 0; return () => `event-${++n}`; })(),
  });
  return {
    controller, state, calls, setNow(value) { now = value; },
    setRelocate(value) { relocate = value; }, setRelease(value) { release = value; },
  };
}

test('policy thresholds are exactly 7 and 15 days', () => {
  assert.equal(PROJECT_INACTIVITY_POLICY.pauseAfterMs, 7 * DAY);
  assert.equal(PROJECT_INACTIVITY_POLICY.releaseAfterMs, 15 * DAY);
});

test('project remains active immediately before day 7 and pauses at day 7', async () => {
  const h = harness();
  h.setNow(7 * DAY - 1);
  assert.equal((await h.controller.evaluateProject('project-1')).status, 'active');
  h.setNow(7 * DAY);
  assert.equal((await h.controller.evaluateProject('project-1')).status, 'paused');
  assert.equal(h.state.lifecycleStatus, 'paused');
});

test('does not release storage before day 15; relocates and verifies before release at day 15', async () => {
  const h = harness({ lifecycleStatus: 'paused' });
  h.setNow(15 * DAY - 1);
  assert.equal((await h.controller.evaluateProject('project-1')).status, 'paused');
  assert.equal(h.calls.some(x => x.type === 'release-capacity'), false);
  h.setNow(15 * DAY);
  const result = await h.controller.evaluateProject('project-1');
  assert.equal(result.status, 'storage-released');
  assert.equal(result.dataDeleted, false);
  assert.deepEqual(h.calls.filter(x => ['relocate', 'release-capacity'].includes(x.type)).map(x => x.type),
    ['relocate', 'release-capacity']);
});

test('failed replica relocation leaves capacity reserved', async () => {
  const h = harness({ lifecycleStatus: 'paused' });
  h.setNow(15 * DAY);
  h.setRelocate(false);
  const result = await h.controller.evaluateProject('project-1');
  assert.equal(result.status, 'release-pending');
  assert.equal(h.calls.some(x => x.type === 'release-capacity'), false);
  assert.equal(h.state.lifecycleStatus, 'storage_release_pending');
});

test('unconfirmed capacity release leaves project pending', async () => {
  const h = harness({ lifecycleStatus: 'paused' });
  h.setNow(15 * DAY);
  h.setRelease(false);
  const result = await h.controller.evaluateProject('project-1');
  assert.equal(result.status, 'release-pending');
  assert.equal(h.state.lifecycleStatus, 'storage_release_pending');
});

test('health checks and heartbeats do not reset meaningful activity', async () => {
  const h = harness();
  const result = await h.controller.recordMeaningfulActivity({
    projectId: 'project-1', actorId: 'owner-1', actorKind: 'owner',
    activityType: 'heartbeat', idempotencyKey: 'heartbeat-0000001',
  });
  assert.deepEqual(result, { accepted: false, reason: 'non-meaningful-activity' });
  assert.equal(h.calls.some(x => x.type === 'activity'), false);
});

test('valid activity is recorded with idempotency key and server timestamp', async () => {
  const h = harness({ lifecycleStatus: 'paused' });
  h.setNow(20 * DAY);
  const result = await h.controller.recordMeaningfulActivity({
    projectId: 'project-1', actorId: 'owner-1', actorKind: 'owner',
    activityType: 'configuration_committed', idempotencyKey: 'config-change-000001',
  });
  assert.equal(result.accepted, true);
  assert.equal(h.state.lastMeaningfulActivityAt, new Date(20 * DAY).toISOString());
});
