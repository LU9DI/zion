import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReplicaCatalog } from '../src/replica-catalog.js';

const id = n => createHash('sha256').update(n).digest('hex');
const receipt = (chunkId, nodeId, bytes = 100) => ({ chunkId, nodeId, storedBytes: bytes, storedAt: Date.now(), requestId: 'ab'.repeat(16) });

 test('persists replication metadata and reloads it after constructing a new catalog instance', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const chunkId = id('chunk'), nodeId = id('node');
  const catalog = new ReplicaCatalog(root); await catalog.init();
  const saved = await catalog.recordReplication({ chunkId, bytes: 100, desiredReplicas: 1, receipts: [receipt(chunkId, nodeId)] });
  assert.equal(saved.status, 'replication-confirmed');
  const restarted = new ReplicaCatalog(root); await restarted.init();
  assert.equal((await restarted.get(chunkId)).receipts[0].nodeId, nodeId);
});

test('marks a node unavailable without deleting its historical receipt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const chunkId = id('chunk'), secondChunkId = id('second-chunk'), nodeId = id('node');
  const catalog = new ReplicaCatalog(root); await catalog.init();
  await catalog.recordReplication({ chunkId, bytes: 100, desiredReplicas: 2, receipts: [receipt(chunkId, nodeId)] });
  await catalog.recordReplication({ chunkId: secondChunkId, bytes: 100, desiredReplicas: 1, receipts: [receipt(secondChunkId, nodeId)] });
  assert.equal((await catalog.get(chunkId)).status, 'under-replicated');
  assert.deepEqual(await catalog.markNodeUnavailable(nodeId), { changed: 2 });
  const restarted = new ReplicaCatalog(root); await restarted.init();
  for (const idToCheck of [chunkId, secondChunkId]) {
    const entry = await restarted.get(idToCheck);
    assert.equal(entry.receipts.length, 1, 'historical receipt must survive restart');
    assert.equal(entry.receipts[0].nodeId, nodeId);
    assert.equal(entry.availability.status, 'under-replicated');
    assert.equal(entry.availability.observations[nodeId].available, false);
    assert.equal(entry.availability.observations[nodeId].reason, 'not-connected');
  }
});

test('rejects duplicate node receipts and invalid metadata', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const chunkId = id('chunk'), nodeId = id('node'), r = receipt(chunkId, nodeId);
  const catalog = new ReplicaCatalog(root); await catalog.init();
  await assert.rejects(catalog.recordReplication({ chunkId, bytes: 100, receipts: [r, r] }), /Duplicate node receipt/);
  await assert.rejects(catalog.recordReplication({ chunkId: 'bad', bytes: 100 }), /Invalid chunk id/);
});

test('fails closed on a corrupt catalog instead of overwriting it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new ReplicaCatalog(root); await catalog.init();
  await writeFile(path.join(root, 'catalog.json'), '{broken', { mode: 0o600 });
  await assert.rejects(catalog.recordReplication({ chunkId: id('chunk'), bytes: 100 }), /corrupt/);
});

test('fails closed when a catalog lock is already held', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-catalog-')); t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new ReplicaCatalog(root, { lockTimeoutMs: 50 }); await catalog.init();
  await mkdir(path.join(root, '.catalog.lock'));
  await assert.rejects(catalog.recordReplication({ chunkId: id('chunk'), bytes: 100 }), /lock is busy/);
});
