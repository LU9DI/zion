import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createNodeIdentity } from '../src/peer-security.js';
import { PeerTransport } from '../src/peer-transport.js';
import { OpaqueReplicaStore, PeerStorageService } from '../src/peer-storage-service.js';
import { createStoreRequest, ReplicaReceiptTracker } from '../src/replication-receipts.js';

const waitFor = async predicate => {
  const started = Date.now();
  while (Date.now() - started < 3000) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for storage protocol result');
};
const envelope = size => { const b = Buffer.concat([Buffer.from('REAC1'), randomBytes(12), randomBytes(16), randomBytes(size)]); return b; };

test('stores opaque encrypted chunks over signed segmented transport and verifies receipt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetIdentity = createNodeIdentity(); const clientIdentity = createNodeIdentity();
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024 * 1024, maxStorageBytes: 2 * 1024 * 1024 }); await store.init();
  const service = new PeerStorageService({ identity: targetIdentity, store, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
  const serverErrors = []; let receivedMessages = 0;
  const server = new PeerTransport({ identity: targetIdentity, onMessage: async (message, socket) => { receivedMessages++; try { await service.handle(message, socket, server); } catch (e) { serverErrors.push(e); throw e; } } });
  const addr = await server.listen(); t.after(() => server.close());
  const tracker = new ReplicaReceiptTracker();
  let accepted; let socket;
  const client = new PeerTransport({ identity: clientIdentity, onMessage: async message => {
    if (message.payload.type === 'STORE_RECEIPT') accepted = tracker.accept(message.envelope);
    if (message.payload.type === 'CHUNK_DATA') await clientService.handle(message, socket, client);
  }});
  const clientService = new PeerStorageService({ identity: clientIdentity, store: {}, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
  socket = await client.connect('127.0.0.1', addr.port); t.after(() => socket.destroy());
  const bytes = envelope(70_000); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const request = createStoreRequest({ chunkId, bytes: bytes.length, targetNodeId: targetIdentity.nodeId }); tracker.register(request);
  const sender = new PeerStorageService({ identity: clientIdentity, store: {}, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
  await sender.sendStoreChunk(client, socket, bytes, targetIdentity.nodeId, () => request);
  try { await waitFor(() => accepted?.ok === true); } catch (e) { throw new Error(`${e.message}; accepted=${JSON.stringify(accepted)}; server messages: ${receivedMessages}; server errors: ${serverErrors.map(x => x.message).join(' | ')}; transfers=${service.transfers.size}; buffered=${service.bufferedBytes}; stored=${await store.sizeBytes()}`); }
  assert.equal(accepted.receipt.nodeId, targetIdentity.nodeId);
  assert.deepEqual(await store.get(chunkId), bytes);
  assert.equal(await store.sizeBytes(), bytes.length);
  const recovered = await clientService.fetchChunk(client, socket, targetIdentity.nodeId, chunkId, { timeoutMs: 1500 });
  assert.deepEqual(recovered, bytes);
});

test('recovers persisted opaque chunks and quota after store reinitialization', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-store-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 64 });
  await first.init();
  const bytes = envelope(10);
  const id = createHash('sha256').update(bytes).digest('hex');
  await first.put(id, bytes);

  const reopened = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 128 });
  await reopened.init();
  assert.deepEqual(await reopened.get(id), bytes);
  assert.equal(await reopened.sizeBytes(), bytes.length);
  assert.equal(reopened.maxStorageBytes, 64);

  const another = envelope(20);
  const anotherId = createHash('sha256').update(another).digest('hex');
  await assert.rejects(reopened.put(anotherId, another), error => error.code === 'REA_CAPACITY_EXHAUSTED');
});

test('rejects a mismatched chunk digest and does not persist it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-store-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 2048 }); await store.init();
  const bytes = envelope(10); const wrongId = '0'.repeat(64);
  await assert.rejects(store.put(wrongId, bytes), /digest mismatch/);
  assert.equal(await store.sizeBytes(), 0);
});

test('enforces opaque replica quota', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-store-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 64, maxStorageBytes: 64 }); await store.init();
  const bytes = envelope(20); const id = createHash('sha256').update(bytes).digest('hex');
  await store.put(id, bytes);
  const next = envelope(20); const nextId = createHash('sha256').update(next).digest('hex');
  await assert.rejects(store.put(nextId, next), /quota exceeded/);
});

test('coordinates quota enforcement across independent store instances', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-store-cross-instance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytesA = envelope(20); const bytesB = envelope(20);
  const quota = Math.max(bytesA.length, bytesB.length);
  const first = new OpaqueReplicaStore(root, { maxChunkBytes: quota, maxStorageBytes: quota });
  const second = new OpaqueReplicaStore(root, { maxChunkBytes: quota, maxStorageBytes: quota });
  await first.init(); await second.init();
  const results = await Promise.allSettled([
    first.put(createHash('sha256').update(bytesA).digest('hex'), bytesA),
    second.put(createHash('sha256').update(bytesB).digest('hex'), bytesB)
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'REA_CAPACITY_EXHAUSTED').length, 1);
  assert.ok((await first.sizeBytes()) <= quota);
});

test('returns an explicit capacity-exhausted protocol response', async () => {
  const targetIdentity = createNodeIdentity(); const clientIdentity = createNodeIdentity();
  const bytes = envelope(20); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const request = createStoreRequest({ chunkId, bytes: bytes.length, targetNodeId: targetIdentity.nodeId });
  const store = { async put() { const error = new Error('quota exceeded'); error.code = 'REA_CAPACITY_EXHAUSTED'; error.availableBytes = 0; throw error; } };
  const service = new PeerStorageService({ identity: targetIdentity, store, maxChunkBytes: 1024, partBytes: 1024 });
  const sent = [];
  const transport = { send(_socket, payload) { sent.push(payload); } };
  await service.handle({ nodeId: clientIdentity.nodeId, payload: {
    type: 'STORE_CHUNK', transferId: randomBytes(16).toString('hex'), chunkId, totalBytes: bytes.length,
    partIndex: 0, partCount: 1, data: bytes.toString('base64'), request
  } }, {}, transport);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'STORE_REJECTED');
  assert.equal(sent[0].requestId, request.requestId);
  assert.equal(sent[0].code, 'CAPACITY_EXHAUSTED');
});

test('expires incomplete transfers and releases buffered memory when a peer goes silent', async () => {
  const target = createNodeIdentity();
  const sender = createNodeIdentity();
  const bytes = envelope(1500);
  const chunkId = createHash('sha256').update(bytes).digest('hex');
  const request = createStoreRequest({ chunkId, bytes: bytes.length, targetNodeId: target.nodeId });
  const service = new PeerStorageService({
    identity: target,
    store: {},
    maxChunkBytes: 4096,
    partBytes: 1024,
    transferTtlMs: 1000
  });
  await service.handle({ nodeId: sender.nodeId, payload: {
    type: 'STORE_CHUNK',
    transferId: randomBytes(16).toString('hex'),
    chunkId,
    totalBytes: bytes.length,
    partIndex: 0,
    partCount: Math.ceil(bytes.length / 1024),
    data: bytes.subarray(0, 1024).toString('base64'),
    request
  } }, {}, { send() {} });
  assert.equal(service.transfers.size, 1);
  assert.equal(service.bufferedBytes, bytes.length);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(service.transfers.size, 0, 'silent peer must not retain an expired transfer');
  assert.equal(service.bufferedBytes, 0, 'expiry must release the reserved memory budget');
});

test('propagates asynchronous transport write failures through storage transfer APIs', async () => {
  const identity = createNodeIdentity();
  const chunk = envelope(20);
  const chunkId = createHash('sha256').update(chunk).digest('hex');
  const service = new PeerStorageService({
    identity,
    store: { async get() { return chunk; } },
    maxChunkBytes: 1024,
    partBytes: 1024,
  });
  const failingTransport = {
    send() { return Promise.reject(new Error('socket write failed')); }
  };

  await assert.rejects(service.handle({
    nodeId: createNodeIdentity().nodeId,
    payload: { type: 'GET_CHUNK', requestId: randomBytes(16).toString('hex'), chunkId },
  }, {}, failingTransport), /socket write failed/);

  await assert.rejects(service.fetchChunk(
    failingTransport, { destroyed: false, writable: true }, createNodeIdentity().nodeId, chunkId, { timeoutMs: 1000 }
  ), /socket write failed/);
  assert.equal(service.pendingGets.size, 0, 'failed send must remove the pending GET immediately');

  await assert.rejects(service.sendStoreChunk(
    failingTransport, { destroyed: false, writable: true }, chunk, createNodeIdentity().nodeId,
    ({ chunkId: id, bytes, targetNodeId }) => ({ chunkId: id, bytes, targetNodeId })
  ), /socket write failed/);
});
 
test('audits actual replica inventory and grants contribution credit only for verified bytes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 4096 });
  await store.init();
  const a = envelope(20); const b = envelope(30);
  await store.put(createHash('sha256').update(a).digest('hex'), a);
  await store.put(createHash('sha256').update(b).digest('hex'), b);
  const { FairSharePolicy } = await import('../src/fair-share-policy.js');
  const policy = new FairSharePolicy({ maxPersonalBytes: 4096, contributionRatio: 0.5 });
  const service = new PeerStorageService({ identity: createNodeIdentity(), store });
  const report = await service.refreshVerifiedContribution(policy);
  assert.equal(report.chunkCount, 2);
  assert.equal(report.verifiedBytes, a.length + b.length);
  assert.equal(policy.snapshot().contributionBytes, a.length + b.length);
  assert.equal(report.personalQuotaBytes, Math.floor((a.length + b.length) / 2));
});

test('inventory audit fails closed on corrupted stored replica and grants no new credit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-audit-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 4096 });
  await store.init();
  const bytes = envelope(20); const id = createHash('sha256').update(bytes).digest('hex');
  await store.put(id, bytes);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, id.slice(0, 2), id.slice(2)), envelope(20));
  const { FairSharePolicy } = await import('../src/fair-share-policy.js');
  const policy = new FairSharePolicy({ maxPersonalBytes: 4096, contributionRatio: 0.5 });
  policy.setVerifiedContributionBytes(777);
  const service = new PeerStorageService({ identity: createNodeIdentity(), store });
  await assert.rejects(service.refreshVerifiedContribution(policy), /integrity check failed|digest mismatch/);
  assert.equal(policy.snapshot().contributionBytes, 0);
  assert.equal(policy.snapshot().personalQuotaBytes, 0);
});


test('cooperatively pauses an inventory audit between batches without revoking still-fresh credit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-audit-pause-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 4096 });
  await store.init();
  for (let i = 0; i < 3; i++) {
    const bytes = envelope(20 + i);
    await store.put(createHash('sha256').update(bytes).digest('hex'), bytes);
  }
  const { FairSharePolicy } = await import('../src/fair-share-policy.js');
  const policy = new FairSharePolicy({ maxPersonalBytes: 4096, contributionRatio: 0.5 });
  policy.setVerifiedContributionBytes(1234);
  const service = new PeerStorageService({ identity: createNodeIdentity(), store });
  let checks = 0;
  await assert.rejects(service.refreshVerifiedContribution(policy, {
    batchSize: 1,
    shouldContinue: async () => ++checks < 3,
  }), error => error.code === 'REA_AUDIT_PAUSED');
  assert.equal(checks, 3);
  assert.equal(policy.snapshot().contributionBytes, 1234);
  assert.equal(policy.snapshot().personalQuotaBytes, 617);
});

test('inventory audit refuses unbounded entry scans', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-audit-bound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 4096 });
  await store.init();
  const bytes = envelope(20); await store.put(createHash('sha256').update(bytes).digest('hex'), bytes);
  await assert.rejects(store.auditInventory({ maxEntries: 0 }), /Invalid inventory audit limit/);
});

test('durable inventory checkpoint resumes only after re-verifying the full current inventory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-audit-resume-'));
  const checkpointDir = await mkdtemp(path.join(tmpdir(), 'rea-peer-checkpoint-'));
  const checkpointPath = path.join(checkpointDir, 'inventory.json');
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(checkpointDir, { recursive: true, force: true })]));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 4096 });
  await store.init();
  for (let i = 0; i < 3; i++) {
    const bytes = envelope(20 + i);
    await store.put(createHash('sha256').update(bytes).digest('hex'), bytes);
  }
  const { FairSharePolicy } = await import('../src/fair-share-policy.js');
  const policy = new FairSharePolicy({ maxPersonalBytes: 4096, contributionRatio: 0.5 });
  policy.setVerifiedContributionBytes(1234);
  const service = new PeerStorageService({ identity: createNodeIdentity(), store });
  let checks = 0;
  await assert.rejects(service.refreshVerifiedContribution(policy, {
    batchSize: 1, checkpointPath, shouldContinue: async () => ++checks < 3,
  }), error => error.code === 'REA_AUDIT_PAUSED');
  assert.equal(policy.snapshot().contributionBytes, 1234, 'partial checkpoint must not change credit');
  const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.equal(checkpoint.version, 1);
  assert.equal(checkpoint.nextIndex, 2);
  const report = await service.refreshVerifiedContribution(policy, { batchSize: 1, checkpointPath });
  assert.equal(report.resumed, true);
  assert.equal(report.chunkCount, 3);
  assert.equal(report.verifiedBytes, report.chunks.reduce((n, chunk) => n + chunk.bytes, 0));
  assert.equal(policy.snapshot().contributionBytes, report.verifiedBytes);
  await assert.rejects(lstat(checkpointPath), error => error.code === 'ENOENT');
});

test('durable audit checkpoint rejects an inventory changed since interruption', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-peer-audit-changed-'));
  const checkpointDir = await mkdtemp(path.join(tmpdir(), 'rea-peer-checkpoint-changed-'));
  const checkpointPath = path.join(checkpointDir, 'inventory.json');
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(checkpointDir, { recursive: true, force: true })]));
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: 1024, maxStorageBytes: 4096 });
  await store.init();
  const first = envelope(20); await store.put(createHash('sha256').update(first).digest('hex'), first);
  const service = new PeerStorageService({ identity: createNodeIdentity(), store });
  let checks = 0;
  await assert.rejects(store.auditInventory({ batchSize: 1, checkpointPath, shouldContinue: async () => ++checks < 2 }), error => error.code === 'REA_AUDIT_PAUSED');
  const second = envelope(21); await store.put(createHash('sha256').update(second).digest('hex'), second);
  await assert.rejects(store.auditInventory({ checkpointPath }), error => error.code === 'REA_AUDIT_INVENTORY_CHANGED');
});

test('storage boundary rejects a request with extra fields before reserving transfer memory', async () => {
  const targetIdentity = createNodeIdentity(); const clientIdentity = createNodeIdentity();
  const bytes = envelope(20); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const request = { ...createStoreRequest({ chunkId, bytes: bytes.length, targetNodeId: targetIdentity.nodeId }), injected: true };
  const store = { async put() { throw new Error('must not persist invalid request'); } };
  const service = new PeerStorageService({ identity: targetIdentity, store, maxChunkBytes: 1024, partBytes: 1024 });
  await assert.rejects(service.handle({ nodeId: clientIdentity.nodeId, payload: {
    type: 'STORE_CHUNK', transferId: randomBytes(16).toString('hex'), chunkId, totalBytes: bytes.length,
    partIndex: 0, partCount: 1, data: bytes.toString('base64'), request
  } }, {}, { send() {} }), /invalid-request-fields/);
  assert.equal(service.transfers.size, 0);
  assert.equal(service.bufferedBytes, 0);
});


test('does not issue a storage receipt when adapter read-back fails integrity verification', async () => {
  const targetIdentity = createNodeIdentity(); const clientIdentity = createNodeIdentity();
  const bytes = envelope(20); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const request = createStoreRequest({ chunkId, bytes: bytes.length, targetNodeId: targetIdentity.nodeId });
  const sent = []; let committed = 0; let released = 0;
  const store = {
    async put(id, value) { return { id, bytes: value.length, alreadyPresent: false }; },
    async get() { return Buffer.alloc(bytes.length, 7); }
  };
  const abuseGuard = { async reserve() { return { ok: true, async commit() { committed++; }, async release() { released++; } }; } };
  const service = new PeerStorageService({ identity: targetIdentity, store, abuseGuard, maxChunkBytes: 1024, partBytes: 1024 });
  const transport = { send(_socket, payload) { sent.push(payload); } };
  await assert.rejects(service.handle({ nodeId: clientIdentity.nodeId, payload: {
    type: 'STORE_CHUNK', transferId: randomBytes(16).toString('hex'), chunkId, totalBytes: bytes.length,
    partIndex: 0, partCount: 1, data: bytes.toString('base64'), request
  } }, {}, transport), /read-back verification failed/);
  assert.equal(sent.some(message => message.type === 'STORE_RECEIPT'), false);
  assert.equal(committed, 0);
  assert.equal(released, 1);
});

test('accepts Rust storage adapter receipt shape after verified read-back', async () => {
  const targetIdentity = createNodeIdentity(); const clientIdentity = createNodeIdentity();
  const bytes = envelope(21); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const request = createStoreRequest({ chunkId, bytes: bytes.length, targetNodeId: targetIdentity.nodeId });
  const sent = [];
  const store = {
    async put(id, value) { return { chunkId: id, bytes: value.length, alreadyPresent: false }; },
    async get() { return Buffer.from(bytes); }
  };
  const service = new PeerStorageService({ identity: targetIdentity, store, maxChunkBytes: 1024, partBytes: 1024 });
  const transport = { send(_socket, payload) { sent.push(payload); } };
  await service.handle({ nodeId: clientIdentity.nodeId, payload: {
    type: 'STORE_CHUNK', transferId: randomBytes(16).toString('hex'), chunkId, totalBytes: bytes.length,
    partIndex: 0, partCount: 1, data: bytes.toString('base64'), request
  } }, {}, transport);
  assert.equal(sent.some(message => message.type === 'STORE_RECEIPT'), true);
});
