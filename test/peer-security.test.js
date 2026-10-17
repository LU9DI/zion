import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity, signPeerMessage, signPeerFrame, verifyPeerMessage, ReplayGuard, PeerRateLimiter } from '../src/peer-security.js';

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

test('replay guard membership check never inserts or consumes capacity', () => {
  const g = new ReplayGuard({ ttlMs: 100, maxEntries: 1 });
  const m = { nodeId: 'a'.repeat(64), nonce: '1'.repeat(32) };
  assert.equal(g.has(m), false, 'an unseen message is not a replay');
  assert.equal(g.seen.size, 0, 'checking membership must not insert an entry');
  assert.equal(g.accept(m, 0), true);
  assert.equal(g.has(m), true, 'an accepted message is reported as a replay');
  assert.equal(g.has(null), false);
  assert.equal(g.has({ nodeId: 'a'.repeat(64) }), false);
  // A full cache must not report unseen messages as replays, so callers do not attribute
  // capacity exhaustion to a specific peer.
  assert.equal(g.has({ nodeId: 'b'.repeat(64), nonce: '2'.repeat(32) }), false);
  assert.equal(g.accept({ nodeId: 'b'.repeat(64), nonce: '2'.repeat(32) }, 0), false);
  assert.equal(g.has({ nodeId: 'b'.repeat(64), nonce: '2'.repeat(32) }), false, 'a rejected insertion is not cached');
  assert.equal(g.seen.size, 1, 'membership checks never evict accepted entries');
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

test('signPeerFrame produces a wire frame equivalent to signPeerMessage and reports exact payload size', () => {
  const id = createNodeIdentity();
  const payload = { type: 'CHUNK_DATA', b: [1, 'é"\n', null, true], a: { z: 1, y: 'x'.repeat(1000) } };
  const opts = { now: 5000, nonce: 'c'.repeat(32) };
  const { frame, payloadBytes } = signPeerFrame(id, payload, opts);
  assert.equal(frame.at(-1), 0x0a);
  const parsed = JSON.parse(frame.subarray(0, -1).toString('utf8'));
  const checked = verifyPeerMessage(parsed, { now: 5000 });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.payload, payload);
  assert.equal(checked.payloadBytes, payloadBytes);
  assert.equal(payloadBytes, Buffer.byteLength(JSON.stringify(payload)));
  const reference = signPeerMessage(id, payload, opts);
  assert.equal(parsed.signature, reference.signature); // Ed25519 is deterministic: identical signed bytes
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(reference).sort());
  assert.throws(() => signPeerFrame(id, { type: 'X', bad: undefined }, opts), TypeError);
  assert.throws(() => signPeerFrame(id, { type: 'X', big: 'a'.repeat(300 * 1024) }, opts), RangeError);
  // multi-byte text: character count is under the limit but the UTF-8 size is over it
  assert.throws(() => signPeerFrame(id, { type: 'X', t: '€'.repeat(60) }, { ...opts, maxPayloadBytes: 100 }), /too large/);
});

test('canonical string fast path is byte-identical to JSON.stringify for plain, escaped and non-ASCII text', () => {
  const id = createNodeIdentity();
  const samples = [
    'A'.repeat(5000), Buffer.alloc(70_000, 7).toString('base64'),
    'x'.repeat(2000) + '"' + 'y'.repeat(2000), 'x'.repeat(2000) + '\\', 'x'.repeat(2000) + '\n',
    'x'.repeat(2000) + 'é', 'x'.repeat(2000) + '\u007f', 'x'.repeat(2000) + '\ud800', 'x'.repeat(2000) + ' ', '',
  ];
  for (const text of samples) {
    const { frame } = signPeerFrame(id, { type: 'T', data: text }, { now: 1, nonce: 'd'.repeat(32), maxPayloadBytes: 1 << 20 });
    const reference = signPeerMessage(id, { type: 'T', data: text }, { now: 1, nonce: 'd'.repeat(32) });
    assert.equal(JSON.parse(frame.subarray(0, -1).toString('utf8')).signature, reference.signature);
  }
  for (let i = 0; i < 200; i++) {
    const length = 1024 + Math.floor(Math.random() * 3000);
    const text = Array.from({ length }, () => String.fromCharCode(Math.floor(Math.random() * 0x250))).join('');
    const { frame } = signPeerFrame(id, { type: 'T', data: text }, { now: 1, nonce: 'e'.repeat(32), maxPayloadBytes: 1 << 20 });
    const reference = signPeerMessage(id, { type: 'T', data: text }, { now: 1, nonce: 'e'.repeat(32) });
    assert.equal(JSON.parse(frame.subarray(0, -1).toString('utf8')).signature, reference.signature);
  }
});

test('rate limiter fails closed on clock rollback without granting duplicate refill', () => {
  let now = 1000;
  const limiter = new PeerRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
  assert.equal(limiter.allow('peer'), true);
  assert.equal(limiter.allow('peer'), true);
  assert.equal(limiter.allow('peer'), false);
  const exhausted = { ...limiter.buckets.get('peer') };

  now = 0;
  assert.equal(limiter.allow('peer'), false, 'a backwards clock must not move the refill baseline');
  assert.equal(limiter.retryAfterMs('peer'), Infinity, 'do not predict refill while the clock is behind');
  assert.deepEqual(limiter.buckets.get('peer'), exhausted, 'rollback must not mutate token state');

  now = 1000;
  assert.equal(limiter.allow('peer'), false, 'catching up to the prior timestamp must not create tokens');
  now = 2000;
  assert.equal(limiter.allow('peer'), true, 'tokens refill after genuinely advancing beyond the prior timestamp');
});
