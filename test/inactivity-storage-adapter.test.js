import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OpaqueReplicaStore } from '../src/peer-storage-service.js';
import { createInactivityStorageAdapter } from '../src/inactivity-storage-adapter.js';

function envelope(size = 40) { const b = Buffer.alloc(size); Buffer.from('REAC1').copy(b); return b; }

test('adapts real store capacity and verified inventory without deleting replicas', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-inactivity-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = envelope();
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 128, maxStorageBytes: 512 });
  await store.init();
  await store.put(createHash('sha256').update(bytes).digest('hex'), bytes);
  const adapter = createInactivityStorageAdapter({ store });
  assert.equal(await adapter.getCapacity(), 512);
  assert.equal(await adapter.getUsage(), bytes.length);
  await adapter.setCapacity(256);
  assert.equal(await adapter.getCapacity(), 256);
  assert.equal((await store.get(createHash('sha256').update(bytes).digest('hex'))).length, bytes.length);
});

test('fails closed when requested capacity is below existing replica usage', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-inactivity-adapter-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytesA = envelope(60); const bytesB = envelope(60); bytesB[10] = 1;
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 256 });
  await store.init();
  await store.put(createHash('sha256').update(bytesA).digest('hex'), bytesA);
  await store.put(createHash('sha256').update(bytesB).digest('hex'), bytesB);
  const adapter = createInactivityStorageAdapter({ store });
  await assert.rejects(adapter.setCapacity(64), error => error.code === 'REA_QUOTA_REDUCTION_UNSAFE');
  assert.equal(await adapter.getCapacity(), 256);
  assert.equal(await adapter.getUsage(), bytesA.length + bytesB.length);
});

test('rejects invalid adapter wiring', () => {
  assert.throws(() => createInactivityStorageAdapter({ store: {} }), /Invalid inactivity storage adapter/);
});

test('persists the shared storage quota across store instances and restarts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-inactivity-quota-persist-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 512 });
  await first.init();
  await first.setCapacityBytes(256);
  const second = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 512 });
  await second.init();
  assert.equal(await second.getCapacityBytes(), 256, 'saved quota overrides constructor default');
  const third = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 512 });
  await third.init();
  assert.equal(await third.getCapacityBytes(), 256, 'quota remains after a fresh store instance initializes');
});
