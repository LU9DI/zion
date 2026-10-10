import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReplicaCatalog } from '../src/replica-catalog.js';
import { ReplicaReconciliationService } from '../src/replica-reconciliation-service.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = (chunkId, nodeId, bytes) => ({ chunkId, nodeId, storedBytes: bytes, storedAt: Date.now(), requestId: randomBytes(16).toString('hex') });

 test('reconciles fresh verified availability without deleting historical receipts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-reconcile-')); t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = Buffer.concat([Buffer.from('REAC1'), randomBytes(64)]);
  const chunkId = hash(envelope), nodeA = 'a'.repeat(64), nodeB = 'b'.repeat(64), owner = 'c'.repeat(64);
  const catalog = new ReplicaCatalog(path.join(root, 'catalog')); await catalog.init();
  await catalog.recordReplication({ chunkId, bytes: envelope.length, desiredReplicas: 2, receipts: [receipt(chunkId, nodeA, envelope.length), receipt(chunkId, nodeB, envelope.length)] });
  const service = new ReplicaReconciliationService({ catalog, transport: {}, storageService: { identity: { nodeId: owner }, fetchChunk: async (_t, _s, nodeId) => nodeId === nodeA ? envelope : Buffer.from('bad') } });
  const socket = { destroyed: false, writable: true };
  const result = await service.reconcile({ peers: [{ nodeId: nodeA, socket }, { nodeId: nodeB, socket }] });
  assert.equal(result.scanned, 1); assert.equal(result.checkedPeers, 2);
  assert.equal(result.results[0].currentlyVerified, 1);
  const entry = await catalog.get(chunkId);
  assert.equal(entry.receipts.length, 2, 'reconciliation preserves historical signed receipts');
  assert.equal(entry.availability.status, 'under-replicated');
  assert.equal(entry.availability.observations[nodeA].available, true);
  assert.equal(entry.availability.observations[nodeB].available, false);
 });

test('does not mark disconnected historical receipts unavailable without checking them', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-reconcile-')); t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = Buffer.concat([Buffer.from('REAC1'), randomBytes(64)]), chunkId = hash(envelope), nodeA = 'a'.repeat(64);
  const catalog = new ReplicaCatalog(path.join(root, 'catalog')); await catalog.init();
  await catalog.recordReplication({ chunkId, bytes: envelope.length, desiredReplicas: 1, receipts: [receipt(chunkId, nodeA, envelope.length)] });
  const service = new ReplicaReconciliationService({ catalog, transport: {}, storageService: { identity: { nodeId: 'c'.repeat(64) }, fetchChunk: async () => { throw new Error('must not fetch'); } } });
  const result = await service.reconcile({ peers: [] });
  assert.equal(result.checkedPeers, 0);
  const entry = await catalog.get(chunkId);
  assert.equal(entry.receipts.length, 1);
  assert.equal(entry.availability.status, 'unverified');
 });

test('rejects invalid reconciliation bounds', async () => {
  assert.throws(() => new ReplicaReconciliationService({ catalog: {}, transport: {}, storageService: {}, maxEntries: 0 }), /configuration/);
});
