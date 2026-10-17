import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity, signPeerMessage, verifyPeerMessage, ReplayGuard, PeerRateLimiter } from '../src/peer-security.js';

test('Ed25519 peer messages verify and bind the node ID to its public key', () => {
  const id = createNodeIdentity();
  const msg = signPeerMessage(id, { type: 'PING', capabilities: ['storage'] }, { now: 1000, nonce: 'a'.repeat(32) });
  assert.equal(verifyPeerMessage(msg, { now: 1000 }).ok, true);
  assert.equal(verifyPeerMessage({ ...msg, payload: { type: 'ADMIN' } }, { now: 1000 }).reason, 'bad-signature');
  assert.equal(verifyPeerMessage({ ...msg, nodeId: 'b'.repeat(64) }, { now: 1000 }).reason, 'identity-mismatch');
});

test('peer messages reject stale and malformed envelopes', () => {
  const id = createNodeIdentity();
  const msg = signPeerMessage(id, { type: 'PING' }, { now: 1000, nonce: 'b'.repeat(32) });
  assert.equal(verifyPeerMessage(msg, { now: 200_000 }).reason, 'stale-timestamp');
  assert.equal(verifyPeerMessage({ ...msg, nonce: 'x' }, { now: 1000 }).reason, 'invalid-nonce');
});

test('replay guard accepts once and rejects duplicates and cache overflow', () => {
  const g = new ReplayGuard({ ttlMs: 100, maxEntries: 1 });
  const m = { nodeId: 'a', nonce: '1' };
  assert.equal(g.accept(m, 0), true); assert.equal(g.accept(m, 1), false);
  assert.equal(g.accept({ nodeId: 'b', nonce: '2' }, 1), false);
  assert.equal(g.accept({ nodeId: 'b', nonce: '2' }, 101), true);
});

test('token bucket rate-limits a noisy peer and refills gradually', () => {
  let now = 0; const r = new PeerRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
  assert.equal(r.allow('peer'), true); assert.equal(r.allow('peer'), true); assert.equal(r.allow('peer'), false);
  now = 1000; assert.equal(r.allow('peer'), true);
});

test('rate limiter bounds peer cardinality and fails closed when full', () => {
  let now = 0;
  const limiter = new PeerRateLimiter({ capacity: 1, refillPerSecond: 1, maxPeers: 2, idleTtlMs: 100, now: () => now });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('b'), true);
  assert.equal(limiter.allow('c'), false);
  assert.equal(limiter.buckets.size, 2);
  now = 101;
  assert.equal(limiter.allow('c'), true);
  assert.equal(limiter.buckets.size, 1);
});


test('replay guard expires entries through an ordered heap and rejects invalid clocks', () => {
  const guard = new ReplayGuard({ ttlMs: 10, maxEntries: 3 });
  assert.equal(guard.accept({ nodeId: 'a', nonce: '1' }, 100), true);
  assert.equal(guard.accept({ nodeId: 'b', nonce: '2' }, 105), true);
  assert.equal(guard.accept({ nodeId: 'c', nonce: '3' }, 106), true);
  assert.equal(guard.accept({ nodeId: 'd', nonce: '4' }, 107), false, 'cache stays bounded before expiry');
  assert.equal(guard.accept({ nodeId: 'd', nonce: '4' }, 110), true, 'the earliest entry expires at its deadline');
  assert.equal(guard.accept({ nodeId: 'e', nonce: '5' }, Number.NaN), false);
  assert.equal(guard.seen.size, 3);
});

test('rate limiter evicts only idle peers and keeps active ones when stopping the sweep early', () => {
  let now = 0;
  const limiter = new PeerRateLimiter({ capacity: 2, refillPerSecond: 0, maxPeers: 3, idleTtlMs: 100, now: () => now });
  assert.equal(limiter.allow('a'), true);  // t=0
  now = 50; assert.equal(limiter.allow('b'), true);
  now = 90; assert.equal(limiter.allow('a'), true); // 'a' becomes the most recent
  now = 120; assert.equal(limiter.allow('c'), true); // 'b' (idle 70) is still live, nothing evicted
  assert.equal(limiter.buckets.size, 3);
  now = 160; // 'b' idle 110 -> evicted; 'a' (70) and 'c' (40) stay
  assert.equal(limiter.allow('d'), true);
  assert.equal(limiter.buckets.has('b'), false);
  assert.equal(limiter.buckets.has('a') && limiter.buckets.has('c') && limiter.buckets.has('d'), true);
});
