import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { PeerTransport } from '../src/peer-transport.js';
import { OpaqueReplicaStore, PeerStorageService } from '../src/peer-storage-service.js';
import { ReplicationCoordinator } from '../src/replication-coordinator.js';
import { createStoreReceipt } from '../src/replication-receipts.js';
import { planReplicas } from '../src/replica-scheduler.js';
import { ReplicaCatalog } from '../src/replica-catalog.js';

const waitFor = async predicate => {
  const start = Date.now();
  while (Date.now() - start < 4000) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for replication');
};
const envelope = () => Buffer.concat([Buffer.from('REAC1'), randomBytes(12), randomBytes(16), randomBytes(1024)]);

 test('coordinates replicated writes and counts only signed receipts from selected nodes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-coordinator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = createNodeIdentity();
  const catalogRoot = path.join(root, 'owner-catalog');
  const catalog = new ReplicaCatalog(catalogRoot); await catalog.init();
  const remoteNodes = [];
  for (let i = 0; i < 2; i++) {
    const identity = createNodeIdentity();
    const store = new OpaqueReplicaStore(path.join(root, `node-${i}`), { maxChunkBytes: 1024 * 1024, maxStorageBytes: 2 * 1024 * 1024 });
    await store.init();
    const service = new PeerStorageService({ identity, store, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
    const transport = new PeerTransport({ identity, onMessage: (message, socket) => service.handle(message, socket, transport) });
    const address = await transport.listen();
    t.after(() => transport.close());
    remoteNodes.push({ identity, store, service, transport, address });
  }

  let coordinator;
  const ownerTransport = new PeerTransport({ identity: owner, onMessage: (message, socket) => coordinator.handleMessage(message, socket) });
  const senderService = new PeerStorageService({ identity: owner, store: {}, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
  coordinator = new ReplicationCoordinator({ identity: owner, transport: ownerTransport, storageService: senderService, requestTimeoutMs: 2500, maxChunkBytes: 1024 * 1024, catalog });
  t.after(() => ownerTransport.close());

  const peers = [];
  for (const node of remoteNodes) {
    const socket = await ownerTransport.connect('127.0.0.1', node.address.port);
    t.after(() => socket.destroy());
    peers.push({ nodeId: node.identity.nodeId, socket, availableBytes: 2 * 1024 * 1024, online: true, acceptingStorage: true, resourceBudget: { enabled: true }, failureDomain: node.identity.nodeId });
  }
  const bytes = envelope();
  const result = await coordinator.replicate({ envelope: bytes, peers, replicaCount: 2 });
  assert.equal(result.confirmedReplicas, 2);
  assert.equal(result.underReplicated, false);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.catalogPersisted, true);
  assert.equal((await catalog.get(result.chunkId)).receipts.length, 2);
  assert.equal(new Set(result.receipts.map(r => r.nodeId)).size, 2);
  await waitFor(async () => (await remoteNodes[0].store.sizeBytes()) > 0 && (await remoteNodes[1].store.sizeBytes()) > 0);
  for (const node of remoteNodes) assert.deepEqual(await node.store.get(result.chunkId), bytes);
});

test('reports under-replication when fewer eligible nodes exist than requested', async () => {
  const owner = createNodeIdentity();
  const coordinator = new ReplicationCoordinator({ identity: owner, transport: {}, storageService: {}, requestTimeoutMs: 1000 });
  const result = await coordinator.replicate({ envelope: envelope(), peers: [], replicaCount: 3 });
  assert.equal(result.confirmedReplicas, 0);
  assert.equal(result.underReplicated, true);
  assert.equal(result.missingReplicas, 3);
});


test('reroutes a replica after a signed capacity-exhausted response', async () => {
  const owner = createNodeIdentity();
  const identities = [createNodeIdentity(), createNodeIdentity(), createNodeIdentity()];
  const bytes = envelope();
  const chunkId = createHash('sha256').update(bytes).digest('hex');
  const planned = planReplicas({ chunkId, nodes: identities.map(identity => ({ id: identity.nodeId, online: true, acceptingStorage: true, availableBytes: 2_000_000, resourceBudget: { enabled: true }, failureDomain: identity.nodeId })), replicaCount: 3 });
  const capacityNodeId = planned.placements[0].nodeId;
  let coordinator;
  const storageService = {
    sendStoreChunk(_transport, _socket, envelopeBytes, targetNodeId, requestFactory) {
      const request = requestFactory({ chunkId: createHash('sha256').update(envelopeBytes).digest('hex'), bytes: envelopeBytes.length, targetNodeId });
      queueMicrotask(() => {
        if (targetNodeId === capacityNodeId) {
          void coordinator.handleMessage({ nodeId: targetNodeId, payload: { type: 'STORE_REJECTED', requestId: request.requestId, chunkId: request.chunkId, code: 'CAPACITY_EXHAUSTED', availableBytes: 0 } }, {});
        } else {
          const signed = createStoreReceipt(identities.find(i => i.nodeId === targetNodeId), request, { storedBytes: request.bytes });
          void coordinator.handleMessage({ nodeId: targetNodeId, payload: signed.payload, envelope: signed }, {});
        }
      });
    }
  };
  coordinator = new ReplicationCoordinator({ identity: owner, transport: {}, storageService, requestTimeoutMs: 1000, maxChunkBytes: 1_000_000 });
  const peers = identities.map(identity => ({ nodeId: identity.nodeId, socket: { destroyed: false }, availableBytes: 2_000_000, online: true, acceptingStorage: true, resourceBudget: { enabled: true }, failureDomain: identity.nodeId }));
  const result = await coordinator.replicate({ envelope: bytes, peers, replicaCount: 2 });
  assert.equal(result.confirmedReplicas, 2);
  assert.equal(result.underReplicated, false);
  assert.equal(result.attempted, 3);
  assert.ok(result.failures.some(f => f.nodeId === capacityNodeId && f.reason === 'capacity-exhausted'));
});



test('does not report success when local catalog persistence fails after replication round', async () => {
  const owner = createNodeIdentity();
  const coordinator = new ReplicationCoordinator({
    identity: owner, transport: {}, storageService: {},
    catalog: { recordReplication: async () => { throw new Error('disk unavailable'); } }
  });
  await assert.rejects(
    coordinator.replicate({ envelope: envelope(), peers: [], replicaCount: 2 }),
    error => error.code === 'REA_CATALOG_PERSIST_FAILED' && error.replicationResult?.underReplicated === true && /durably recorded/.test(error.message)
  );
});
