import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { PeerTransport } from '../src/peer-transport.js';
import { OpaqueReplicaStore, PeerStorageService } from '../src/peer-storage-service.js';
import { ReplicaRecoveryService } from '../src/replica-recovery-service.js';

const waitFor = async predicate => {
  const until = Date.now() + 3000;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for condition');
};
const envelope = () => Buffer.concat([Buffer.from('REAC1'), randomBytes(12), randomBytes(16), randomBytes(8192)]);

async function makeNode(root, name, onMessageFactory = null) {
  const identity = createNodeIdentity();
  const store = new OpaqueReplicaStore(path.join(root, name), { maxChunkBytes: 1024 * 1024, maxStorageBytes: 2 * 1024 * 1024 });
  await store.init();
  const service = new PeerStorageService({ identity, store, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
  let transport;
  transport = new PeerTransport({ identity, onMessage: (message, socket) => onMessageFactory ? onMessageFactory(message, socket, service, transport) : service.handle(message, socket, transport) });
  const address = await transport.listen();
  return { identity, store, service, transport, address };
}

test('recovers and persists a verified chunk from a remote replica', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = envelope(); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const source = await makeNode(root, 'source');
  await source.store.put(chunkId, bytes);
  const destination = await makeNode(root, 'destination');
  t.after(() => source.transport.close()); t.after(() => destination.transport.close());
  const socket = await destination.transport.connect('127.0.0.1', source.address.port);
  t.after(() => socket.destroy());
  const recovery = new ReplicaRecoveryService({ transport: destination.transport, storageService: destination.service,
    destinationStore: destination.store, requestTimeoutMs: 1500 });
  const result = await recovery.recover({ chunkId, peers: [{ nodeId: source.identity.nodeId, socket }] });
  assert.equal(result.ok, true);
  assert.equal(result.sourceNodeId, source.identity.nodeId);
  assert.equal(result.persistedLocally, true);
  assert.deepEqual(await destination.store.get(chunkId), bytes);
});

test('tries the next peer when the first replica is unavailable', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-recovery-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = envelope(); const chunkId = createHash('sha256').update(bytes).digest('hex');
  const empty = await makeNode(root, 'empty'); const source = await makeNode(root, 'source');
  await source.store.put(chunkId, bytes);
  const clientIdentity = createNodeIdentity();
  const clientStore = new OpaqueReplicaStore(path.join(root, 'client'), { maxChunkBytes: 1024 * 1024, maxStorageBytes: 2 * 1024 * 1024 });
  await clientStore.init();
  const clientService = new PeerStorageService({ identity: clientIdentity, store: clientStore, maxChunkBytes: 1024 * 1024, partBytes: 16 * 1024 });
  const clientTransport = new PeerTransport({ identity: clientIdentity, onMessage: (message, socket) => clientService.handle(message, socket, clientTransport) });
  await clientTransport.listen();
  t.after(() => clientTransport.close()); t.after(() => empty.transport.close()); t.after(() => source.transport.close());
  const emptySocket = await clientTransport.connect('127.0.0.1', empty.address.port);
  const sourceSocket = await clientTransport.connect('127.0.0.1', source.address.port);
  t.after(() => emptySocket.destroy()); t.after(() => sourceSocket.destroy());
  const recovery = new ReplicaRecoveryService({ transport: clientTransport, storageService: clientService, requestTimeoutMs: 300 });
  const result = await recovery.recover({ chunkId, peers: [
    { nodeId: empty.identity.nodeId, socket: emptySocket }, { nodeId: source.identity.nodeId, socket: sourceSocket }
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.sourceNodeId, source.identity.nodeId);
  assert.equal(result.attemptedPeers, 2);
  assert.deepEqual(result.envelope, bytes);
});

test('returns explicit failure when no peer has a verified copy', async () => {
  const recovery = new ReplicaRecoveryService({ transport: {}, storageService: { identity: { nodeId: 'a'.repeat(64) }, fetchChunk: async () => { throw new Error('offline'); } } });
  const result = await recovery.recover({ chunkId: 'b'.repeat(64), peers: [{ nodeId: 'c'.repeat(64), socket: { destroyed: false, writable: true } }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-verified-replica-available');
});


test('recovery skips quarantined and explicitly unverified peers before network requests', async () => {
  let fetchCalls = 0;
  const recovery = new ReplicaRecoveryService({ transport: {}, storageService: {
    identity: { nodeId: 'a'.repeat(64) },
    fetchChunk: async (_transport, _socket, _nodeId, chunkId) => {
      fetchCalls++;
      return Buffer.from(chunkId, 'hex');
    }
  } });
  const bytes = Buffer.from('verified-recovery-source');
  const chunkId = createHash('sha256').update(bytes).digest('hex');
  recovery.storageService.fetchChunk = async () => { fetchCalls++; return bytes; };
  const result = await recovery.recover({ chunkId, peers: [
    { nodeId: 'b'.repeat(64), socket: { destroyed: false, writable: true }, quarantined: true },
    { nodeId: 'c'.repeat(64), socket: { destroyed: false, writable: true }, integrityStatus: 'unknown' },
    { nodeId: 'd'.repeat(64), socket: { destroyed: false, writable: true }, integrityStatus: 'verified' }
  ] });
  assert.equal(fetchCalls, 1, 'only the verified peer should be contacted');
  assert.equal(result.ok, true);
  assert.equal(result.sourceNodeId, 'd'.repeat(64));
  assert.equal(result.attemptedPeers, 1);
  assert.deepEqual(result.envelope, bytes);
});
