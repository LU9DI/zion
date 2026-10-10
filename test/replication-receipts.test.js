import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createStoreRequest, createStoreReceipt, validateStoreRequest, ReplicaReceiptTracker } from '../src/replication-receipts.js';

const hash = char => char.repeat(64);

 test('accepts only a signed receipt matching a registered request', () => {
  let now = 1000;
  const owner = createNodeIdentity();
  const storage = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('a'), bytes: 2048, targetNodeId: storage.nodeId, now });
  const tracker = new ReplicaReceiptTracker({ now: () => now });
  tracker.register(request);
  const receipt = createStoreReceipt(storage, request, { storedBytes: 2048, now: 1001 });
  now = 1001;
  const accepted = tracker.accept(receipt);
  assert.equal(accepted.ok, true);
  assert.equal(tracker.confirmedCount(hash('a')), 1);
  assert.equal(tracker.isFullyReplicated(hash('a'), 1), true);
  assert.equal(tracker.isFullyReplicated(hash('a'), 3), false);
  assert.notEqual(owner.nodeId, storage.nodeId);
});

test('rejects a receipt signed by a node other than the requested target', () => {
  let now = 1000;
  const target = createNodeIdentity();
  const impostor = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('b'), bytes: 100, targetNodeId: target.nodeId, now });
  const tracker = new ReplicaReceiptTracker({ now: () => now });
  tracker.register(request);
  const receipt = createStoreReceipt({ ...impostor }, { ...request, targetNodeId: impostor.nodeId }, { storedBytes: 100, now: 1001 });
  now = 1001;
  assert.deepEqual(tracker.accept(receipt), { ok: false, reason: 'unexpected-node' });
});

test('rejects duplicate receipts from one node and consumes request once', () => {
  let now = 1000;
  const storage = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('c'), bytes: 50, targetNodeId: storage.nodeId, now });
  const tracker = new ReplicaReceiptTracker({ now: () => now });
  tracker.register(request);
  const receipt = createStoreReceipt(storage, request, { storedBytes: 50, now: 1001 });
  now = 1001;
  assert.equal(tracker.accept(receipt).ok, true);
  assert.equal(tracker.accept(receipt).reason, 'unknown-or-consumed-request');
});

test('rejects mismatched byte count before a receipt can be created', () => {
  const storage = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('d'), bytes: 50, targetNodeId: storage.nodeId, now: 1000 });
  assert.throws(() => createStoreReceipt(storage, request, { storedBytes: 49, now: 1001 }), /does not match/);
});

test('expires pending requests and bounds tracker memory', () => {
  let now = 1000;
  const storage = createNodeIdentity();
  const tracker = new ReplicaReceiptTracker({ now: () => now, maxPending: 1 });
  const first = createStoreRequest({ chunkId: hash('e'), bytes: 50, targetNodeId: storage.nodeId, now, ttlMs: 10 });
  tracker.register(first);
  const second = createStoreRequest({ chunkId: hash('f'), bytes: 50, targetNodeId: storage.nodeId, now, ttlMs: 100 });
  assert.throws(() => tracker.register(second), /capacity/);
  now = 1011;
  tracker.register(second);
  assert.equal(tracker.pending.size, 1);
});


test('store request validator rejects extra fields and mismatched destination commitments', () => {
  const target = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('a'), bytes: 100, targetNodeId: target.nodeId, now: 10_000 });
  assert.equal(validateStoreRequest(request, { now: 10_001, expectedTargetNodeId: target.nodeId, expectedChunkId: hash('a'), expectedBytes: 100 }).ok, true);
  assert.equal(validateStoreRequest({ ...request, admin: true }, { now: 10_001 }).reason, 'invalid-request-fields');
  assert.equal(validateStoreRequest(request, { now: 10_001, expectedTargetNodeId: hash('b') }).reason, 'wrong-request-target');
  assert.equal(validateStoreRequest(request, { now: 10_001, expectedChunkId: hash('c') }).reason, 'wrong-request-chunk');
});

test('store request validator rejects expired, future-dated and overlong requests', () => {
  const target = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('d'), bytes: 100, targetNodeId: target.nodeId, now: 10_000, ttlMs: 100 });
  assert.equal(validateStoreRequest(request, { now: 10_101 }).reason, 'invalid-request-time-window');
  assert.equal(validateStoreRequest({ ...request, createdAt: 200_000, expiresAt: 200_100 }, { now: 10_000 }).reason, 'invalid-request-time-window');
  assert.equal(validateStoreRequest({ ...request, expiresAt: request.createdAt + 700_000 }, { now: 10_001 }).reason, 'invalid-request-time-window');
});


test('stateless SDK verifier validates signature and request binding', async () => {
  const { verifyStoreReceipt } = await import('../src/replication-receipts.js');
  const target = createNodeIdentity();
  const request = createStoreRequest({ chunkId: hash('f'), bytes: 100, targetNodeId: target.nodeId, now: 10_000 });
  const receipt = createStoreReceipt(target, request, { storedBytes: 100, now: 10_001 });
  assert.equal(verifyStoreReceipt(receipt, request, { now: 10_001 }).ok, true);
  assert.equal(verifyStoreReceipt(receipt, { ...request, bytes: 99 }, { now: 10_001 }).ok, false);
  assert.equal(verifyStoreReceipt({ ...receipt, signature: 'invalid' }, request, { now: 10_001 }).ok, false);
});
