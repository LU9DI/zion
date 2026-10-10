import test from 'node:test';
import assert from 'node:assert/strict';
import { P2PBootstrapCoordinator } from '../src/p2p-bootstrap-coordinator.js';

const peers = [
  { peerId: 'peer-a', failureDomain: 'region-a', multiaddrs: ['/ip4/192.0.2.1/tcp/4001'] },
  { peerId: 'peer-b', failureDomain: 'region-b', multiaddrs: ['/ip4/198.51.100.2/tcp/4001'] },
  { peerId: 'peer-c', failureDomain: 'region-c', multiaddrs: ['/ip4/203.0.113.3/tcp/4001'] },
];

test('bootstrap coordinator requires distinct identities and failure domains', () => {
  assert.throws(() => new P2PBootstrapCoordinator({
    bootstrapPeers: peers.slice(0, 2).map(peer => ({ ...peer, failureDomain: 'same-region' })),
    dialPeer: async peer => ({ peerId: peer.peerId, authenticated: true }),
  }), /failure domains/);
  assert.throws(() => new P2PBootstrapCoordinator({
    bootstrapPeers: [peers[0], { ...peers[1], peerId: peers[0].peerId }],
    dialPeer: async peer => ({ peerId: peer.peerId, authenticated: true }),
  }), /Duplicate bootstrap peer ID/);
});

test('connects only when enough authenticated peers across domains are available', async () => {
  const dialed = [];
  const disconnected = [];
  const coordinator = new P2PBootstrapCoordinator({
    bootstrapPeers: peers,
    minConnected: 2,
    dialPeer: async peer => {
      dialed.push(peer.peerId);
      return { peerId: peer.peerId, authenticated: true };
    },
    disconnectPeer: async peerId => disconnected.push(peerId),
  });
  const status = await coordinator.start();
  assert.equal(status.state, 'running');
  assert.equal(status.connectedCount, 3);
  assert.equal(new Set(status.failureDomains).size, 3);
  assert.deepEqual(new Set(dialed), new Set(peers.map(peer => peer.peerId)));
  const stopped = await coordinator.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.connectedCount, 0);
  assert.deepEqual(new Set(disconnected), new Set(peers.map(peer => peer.peerId)));
});

test('rejects mismatched authenticated identity and rolls back partial connections', async () => {
  const disconnected = [];
  const coordinator = new P2PBootstrapCoordinator({
    bootstrapPeers: peers.slice(0, 2),
    dialPeer: async peer => ({ peerId: peer.peerId === 'peer-a' ? 'impostor' : peer.peerId, authenticated: true }),
    disconnectPeer: async peerId => disconnected.push(peerId),
  });
  await assert.rejects(coordinator.start(), /enough independent bootstrap peers/);
  assert.equal(coordinator.getStatus().state, 'stopped');
  assert.ok(disconnected.includes('impostor'));
  assert.ok(disconnected.includes('peer-b'));
});

test('times out slow bootstrap dials and disconnects late connections', async () => {
  const disconnected = [];
  const coordinator = new P2PBootstrapCoordinator({
    bootstrapPeers: peers.slice(0, 2),
    timeoutMs: 100,
    maxConcurrent: 2,
    dialPeer: async peer => {
      if (peer.peerId === 'peer-a') {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return { peerId: peer.peerId, authenticated: true };
    },
    disconnectPeer: async peerId => disconnected.push(peerId),
  });
  await assert.rejects(coordinator.start(), /enough independent bootstrap peers/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(disconnected.includes('peer-a'));
  assert.ok(disconnected.includes('peer-b'));
});

test('cancelling startup aborts bootstrap dials and leaves the coordinator stopped', async () => {
  const coordinator = new P2PBootstrapCoordinator({
    bootstrapPeers: peers.slice(0, 2),
    timeoutMs: 5000,
    dialPeer: async (peer, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  const start = coordinator.start();
  await new Promise(resolve => setImmediate(resolve));
  await coordinator.stop();
  await assert.rejects(start, /cancelled/);
  assert.equal(coordinator.getStatus().state, 'stopped');
});
