import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AdaptiveStorageCapacity } from '../src/adaptive-storage-capacity.js';

function memoryStore(initial = []) {
  const data = new Map(initial);
  return {
    async get(id) { if (!data.has(id)) { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } return Buffer.from(data.get(id)); },
    async put(id, bytes) { data.set(id, Buffer.from(bytes)); return { id, bytes: bytes.length }; },
    async sizeBytes() { return [...data.values()].reduce((n, b) => n + b.length, 0); },
    async getCapacityBytes() { return 1000; },
    data,
  };
}
const idFor = bytes => createHash('sha256').update(bytes).digest('hex');

test('contribution tiers reduce admission capacity monotonically', () => {
  const store = memoryStore();
  const capacity = new AdaptiveStorageCapacity({ store, baseCapacityBytes: 1000, minCapacityBytes: 100 });
  assert.equal(capacity.evaluate({ telemetryHealthy: true, contributionRatio: 1 }).targetCapacityBytes, 1000);
  assert.equal(capacity.evaluate({ telemetryHealthy: true, contributionRatio: 0.6 }).targetCapacityBytes, 750);
  assert.equal(capacity.evaluate({ telemetryHealthy: true, contributionRatio: 0.3 }).targetCapacityBytes, 500);
  assert.equal(capacity.evaluate({ telemetryHealthy: true, contributionRatio: 0.1 }).targetCapacityBytes, 250);
});

test('reduction blocks new writes over target but preserves existing replicas', async () => {
  const original = Buffer.from('already-stored');
  const store = memoryStore([[idFor(original), original]]);
  const capacity = new AdaptiveStorageCapacity({ store, baseCapacityBytes: 100, minCapacityBytes: 10 });
  capacity.evaluate({ telemetryHealthy: true, contributionRatio: 1 });
  const next = Buffer.from('this-new-replica-is-too-large-for-the-reduced-capacity');
  capacity.evaluate({ telemetryHealthy: true, contributionRatio: 0.1 });
  await assert.rejects(capacity.put(idFor(next), next), error => error.code === 'ZION_ADAPTIVE_CAPACITY_REACHED');
  assert.deepEqual(await capacity.get(idFor(original)), original);
  assert.equal(await capacity.sizeBytes(), original.length);
});

test('unhealthy telemetry disables new admission without blocking reads', async () => {
  const original = Buffer.from('stored');
  const store = memoryStore([[idFor(original), original]]);
  const capacity = new AdaptiveStorageCapacity({ store, baseCapacityBytes: 100, minCapacityBytes: 10 });
  capacity.evaluate({ telemetryHealthy: false, contributionRatio: 1 });
  await assert.rejects(capacity.put(idFor(Buffer.from('x')), Buffer.from('x')), error => error.code === 'ZION_CAPACITY_DISABLED');
  assert.deepEqual(await capacity.get(idFor(original)), original);
});

test('existing identical replica remains idempotent after reduction', async () => {
  const original = Buffer.from('stored');
  const store = memoryStore([[idFor(original), original]]);
  const capacity = new AdaptiveStorageCapacity({ store, baseCapacityBytes: 100, minCapacityBytes: 10 });
  capacity.evaluate({ telemetryHealthy: false });
  assert.equal((await capacity.put(idFor(original), original)).id, idFor(original));
});

test('validates policy inputs and rejects conflicting duplicate ids', async () => {
  const store = memoryStore();
  const capacity = new AdaptiveStorageCapacity({ store, baseCapacityBytes: 100, minCapacityBytes: 10 });
  assert.equal(capacity.evaluate({ telemetryHealthy: false, contributionRatio: 2 }).targetCapacityBytes, 0);
  capacity.evaluate({ telemetryHealthy: true, contributionRatio: 1 });
  const original = Buffer.from('one'); await capacity.put(idFor(original), original);
  await assert.rejects(capacity.put(idFor(original), Buffer.from('two')), /Existing replica content mismatch/);
});

test('concurrent writes cannot race past the adaptive capacity ceiling', async () => {
  const store = memoryStore();
  const capacity = new AdaptiveStorageCapacity({ store, baseCapacityBytes: 80, minCapacityBytes: 10 });
  capacity.evaluate({ telemetryHealthy: true, contributionRatio: 0.1 }); // target: 20 bytes
  const a = Buffer.alloc(12, 1), b = Buffer.alloc(12, 2);
  const outcomes = await Promise.allSettled([capacity.put(idFor(a), a), capacity.put(idFor(b), b)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.code === 'ZION_ADAPTIVE_CAPACITY_REACHED').length, 1);
  assert.equal(await store.sizeBytes(), 12);
});
