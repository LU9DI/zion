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

test('peer verification fails closed when the injected clock is invalid', () => {
  const identity = createNodeIdentity();
  const message = signPeerMessage(identity, { type: 'PING' }, { now: 1000, nonce: 'c'.repeat(32) });
  assert.equal(verifyPeerMessage(message, { now: Number.NaN }).reason, 'invalid-clock');
  assert.equal(verifyPeerMessage(message, { now: Number.POSITIVE_INFINITY }).reason, 'invalid-clock');
});

test('peer verification fails closed when freshness or size policy is invalid', () => {
  const identity = createNodeIdentity();
  const message = signPeerMessage(identity, { type: 'PING' }, { now: 1000, nonce: 'd'.repeat(32) });
  for (const maxClockSkewMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(verifyPeerMessage(message, { now: 1000, maxClockSkewMs }).reason, 'invalid-verification-options');
  }
  for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
    assert.equal(verifyPeerMessage(message, { now: 1000, maxBytes }).reason, 'invalid-verification-options');
  }
  assert.equal(verifyPeerMessage(message, { now: 1000, maxClockSkewMs: 0, maxBytes: 1024 }).ok, true);
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


test('rate limiter expires only oldest idle buckets while preserving recently touched peers', () => {
  let now = 0;
  const limiter = new PeerRateLimiter({ capacity: 10, refillPerSecond: 1, maxPeers: 3, idleTtlMs: 100, now: () => now });
  assert.equal(limiter.allow('older'), true);
  now = 50;
  assert.equal(limiter.allow('newer'), true);
  now = 75;
  assert.equal(limiter.allow('older'), true, 'touching a peer moves its bucket to the newest position');
  now = 151;
  assert.equal(limiter.allow('third'), true);
  assert.equal(limiter.buckets.has('newer'), false, 'the expired oldest bucket is removed');
  assert.equal(limiter.buckets.has('older'), true, 'a recently touched bucket is preserved');
  assert.equal(limiter.buckets.has('third'), true);
});

test('rate limiter fails closed on an invalid clock without corrupting buckets', () => {
  let now = 100;
  const limiter = new PeerRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
  assert.equal(limiter.allow('peer'), true);
  const before = { ...limiter.buckets.get('peer') };
  now = Number.NaN;
  assert.equal(limiter.allow('peer'), false);
  assert.equal(limiter.retryAfterMs('peer'), Infinity);
  assert.deepEqual(limiter.buckets.get('peer'), before);
  assert.equal(limiter.buckets.has('other'), false);
});

test('rate limiter rotates bounded cleanup across maps larger than one sweep batch', () => {
  let now = 0;
  const limiter = new PeerRateLimiter({ capacity: 200, refillPerSecond: 1, maxPeers: 200, idleTtlMs: 100, now: () => now });
  for (let i = 0; i < 130; i++) assert.equal(limiter.allow(`peer-${i}`), true);
  assert.equal(limiter.buckets.size, 130);

  now = 101;
  // One allow() must inspect no more than one 64-entry batch; cleanup continues
  // on subsequent calls rather than making a single frame scan the full map.
  assert.equal(limiter.allow('fresh'), true);
  assert.equal(limiter.buckets.size, 67);
  assert.equal(limiter.allow('fresh'), true);
  assert.equal(limiter.buckets.size, 3);
  assert.equal(limiter.allow('fresh'), true);
  assert.equal(limiter.buckets.size, 1);
  assert.deepEqual([...limiter.buckets.keys()], ['fresh']);
});

test('replay guard expires entries through an ordered heap and rejects invalid clocks', () => {
  const guard = new ReplayGuard({ ttlMs: 10, maxEntries: 3 });
  assert.equal(guard.accept({ nodeId: 'a', nonce: '1' }, 100), true);
  assert.equal(guard.accept({ nodeId: 'b', nonce: '2' }, 105), true);
  assert.equal(guard.accept({ nodeId: 'c', nonce: '3' }, 106), true);
  assert.equal(guard.accept({ nodeId: 'd', nonce: '4' }, 107), false, 'cache stays bounded before expiry');
  assert.equal(guard.accept({ nodeId: 'd', nonce: '4' }, 110), true, 'the earliest entry expires at its deadline');
  assert.equal(guard.accept({ nodeId: 'e', nonce: '5' }, Number.NaN), false);
  assert.equal(guard.accept({ nodeId: 'e', nonce: '5' }, Number.MAX_VALUE), false,
    'unsafe finite clocks must not create entries with infinite expiry');
  assert.equal(guard.accept({ nodeId: 'e', nonce: '5' }, Number.MAX_SAFE_INTEGER + 1), false,
    'unsafe integer clocks must fail closed');
  assert.equal(guard.accept({ nodeId: 'e', nonce: '5' }, Number.MAX_SAFE_INTEGER - 5), false,
    'expiry arithmetic must remain within the safe integer range');
  assert.equal(guard.seen.size, 3);
});
