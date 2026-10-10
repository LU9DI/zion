import test from 'node:test';
import assert from 'node:assert/strict';
import { DhtProviderDiscovery, Libp2pContentRoutingAdapter } from '../src/dht-provider-discovery.js';

const chunk = 'a'.repeat(64);

function fakeRouting(providers = []) {
  const calls = { provide: [], find: [] };
  return {
    calls,
    async provideChunk(id, options) { calls.provide.push({ id, options }); },
    async *findChunkProviders(id, options) { calls.find.push({ id, options }); yield* providers; }
  };
}

test('announces only chunks confirmed locally present', async () => {
  const routing = fakeRouting();
  const discovery = new DhtProviderDiscovery({ routing, hasChunk: async id => id === chunk });
  assert.deepEqual(await discovery.announce(chunk), { chunkId: chunk, announced: true });
  assert.equal(routing.calls.provide.length, 1);
  const missing = new DhtProviderDiscovery({ routing, hasChunk: async () => false });
  await assert.rejects(missing.announce(chunk), /not locally available/);
  assert.equal(routing.calls.provide.length, 1);
});

test('provider discovery deduplicates peers, bounds results, and ignores malformed IDs', async () => {
  const routing = fakeRouting([
    { peerId: 'peer-a', multiaddrs: ['/ip4/127.0.0.1/tcp/4001'] },
    { peerId: 'peer-a', multiaddrs: ['/ip4/127.0.0.1/tcp/4001'] },
    { peerId: 'bad\npeer', multiaddrs: [] },
    { id: { toString: () => 'peer-b' }, multiaddrs: [] },
    { peerId: 'peer-c', multiaddrs: [] }
  ]);
  const discovery = new DhtProviderDiscovery({ routing, hasChunk: async () => true, maxProviders: 2 });
  const result = await discovery.findProviders(chunk);
  assert.deepEqual(result.map(item => item.peerId), ['peer-a', 'peer-b']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(routing.calls.find.length, 1);
});

test('rejects invalid chunk identifiers and invalid limits', async () => {
  const routing = fakeRouting();
  const discovery = new DhtProviderDiscovery({ routing, hasChunk: async () => true });
  await assert.rejects(discovery.findProviders('../secret'), /Invalid chunk ID/);
  await assert.rejects(discovery.announce('f'.repeat(63)), /Invalid chunk ID/);
  assert.throws(() => new DhtProviderDiscovery({ routing, hasChunk: async () => true, maxProviders: 1000 }), /Invalid DHT discovery limits/);
});

test('libp2p adapter validates IDs and delegates using injected CID factory', async () => {
  const cid = { toString: () => 'bafy-test-cid' };
  const calls = [];
  const contentRouting = {
    async provide(value, options) { calls.push(['provide', value, options]); },
    async *findProviders(value, options) { calls.push(['find', value, options]); yield { id: { toString: () => 'peer-x' }, multiaddrs: [] }; }
  };
  const adapter = new Libp2pContentRoutingAdapter({ contentRouting, cidForChunk: async id => ({ ...cid, chunkId: id }) });
  await adapter.provideChunk(chunk);
  const result = [];
  for await (const provider of adapter.findChunkProviders(chunk)) result.push(provider.id.toString());
  assert.deepEqual(result, ['peer-x']);
  assert.equal(calls.length, 2);
  await assert.rejects(adapter.provideChunk('invalid'), /Invalid chunk ID/);
});

test('provider discovery enforces a hard timeout even if the async iterator stalls', async () => {
  const routing = {
    async provideChunk() {},
    findChunkProviders() { return { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } }; }
  };
  const discovery = new DhtProviderDiscovery({ routing, hasChunk: async () => true, timeoutMs: 100 });
  await assert.rejects(discovery.findProviders(chunk), /timed out/);
});

test('announcement applies its timeout to local availability checks', async () => {
  const routing = fakeRouting();
  const discovery = new DhtProviderDiscovery({ routing, hasChunk: () => new Promise(() => {}), timeoutMs: 100 });
  await assert.rejects(discovery.announce(chunk), /timed out/);
  assert.equal(routing.calls.provide.length, 0);
});
