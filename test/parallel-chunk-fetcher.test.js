import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { PeerTransport } from '../src/peer-transport.js';
import { OpaqueReplicaStore, PeerStorageService } from '../src/peer-storage-service.js';
import { fetchChunksParallel } from '../src/parallel-chunk-fetcher.js';

const MAX = 512 * 1024;
const envelope = size => Buffer.concat([Buffer.from('REAC1'), randomBytes(28), randomBytes(size)]);
const sha = b => createHash('sha256').update(b).digest('hex');

async function startPeer(t, chunks) {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-par-')); t.after(() => rm(root, { recursive: true, force: true }));
  const identity = createNodeIdentity();
  const store = new OpaqueReplicaStore(root, { maxChunkBytes: MAX, maxStorageBytes: 16 * MAX }); await store.init();
  for (const bytes of chunks) await store.put(sha(bytes), bytes);
  const service = new PeerStorageService({ identity, store, maxChunkBytes: MAX, partBytes: 32 * 1024 });
  const server = new PeerTransport({ identity, onMessage: (m, s) => service.handle(m, s, server) });
  const addr = await server.listen(); t.after(() => server.close());
  return { identity, addr };
}

async function client(t, peerInfos) {
  const identity = createNodeIdentity();
  const service = new PeerStorageService({ identity, store: {}, maxChunkBytes: MAX, partBytes: 32 * 1024 });
  const sockets = [];
  const transport = new PeerTransport({ identity, onMessage: async (m, socket) => { if (m.payload.type === 'CHUNK_DATA') await service.handle(m, socket, transport); } });
  const peers = [];
  for (const { identity: peerIdentity, addr } of peerInfos) {
    const socket = await transport.connect('127.0.0.1', addr.port); sockets.push(socket);
    peers.push({ nodeId: peerIdentity.nodeId, socket });
  }
  t.after(() => { sockets.forEach(s => s.destroy()); transport.close(); });
  return { transport, service, peers };
}

test('fetches chunks from several peers in parallel and returns them in request order', async t => {
  const chunks = Array.from({ length: 6 }, () => envelope(100_000));
  const a = await startPeer(t, chunks.slice(0, 4)); const b = await startPeer(t, chunks.slice(2));
  const { transport, service, peers } = await client(t, [a, b]);
  const wanted = [chunks[5], chunks[0], chunks[3], chunks[1], chunks[4], chunks[2]];
  const holders = chunk => [a, b].filter((_, i) => (i === 0 ? chunks.slice(0, 4) : chunks.slice(2)).includes(chunk)).map(p => p.identity.nodeId);
  const got = await fetchChunksParallel({ transport, storageService: service, peers, chunks: wanted.map(chunk => ({ chunkId: sha(chunk), peerIds: holders(chunk) })), concurrencyPerPeer: 2 });
  assert.equal(got.length, 6);
  got.forEach((bytes, i) => assert.deepEqual(bytes, wanted[i]));
});

test('retries a chunk on the next candidate peer when the first one drops the connection, and reports unrecoverable chunks', async t => {
  const have = envelope(80_000); const missing = envelope(80_000);
  const empty = await startPeer(t, []); const full = await startPeer(t, [have]);
  const { transport, service, peers } = await client(t, [empty, full]);
  const both = [empty.identity.nodeId, full.identity.nodeId];
  const [bytes] = await fetchChunksParallel({ transport, storageService: service, peers, chunks: [{ chunkId: sha(have), peerIds: both }], timeoutMs: 1500 });
  assert.deepEqual(bytes, have);
  await assert.rejects(fetchChunksParallel({ transport, storageService: service, peers: [peers[1]], chunks: [{ chunkId: sha(missing), peerIds: [full.identity.nodeId] }], timeoutMs: 1500 }),
    error => error instanceof AggregateError && error.errors.length === 1);
});

test('rejects invalid requests and unusable peers without touching the network', async t => {
  const { transport, service } = await client(t, []);
  await assert.rejects(fetchChunksParallel({ transport, storageService: service, peers: [], chunks: ['nope'] }), TypeError);
  await assert.rejects(fetchChunksParallel({ transport, storageService: service, peers: [], chunks: ['a'.repeat(64)] }), AggregateError);
});
