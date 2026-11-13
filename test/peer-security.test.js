import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createNodeIdentity, signPeerMessage, verifyPeerMessage, ReplayGuard, PeerRateLimiter } from '../src/peer-security.js';
import { createEncryptedNodeIdentityRecord, loadEncryptedNodeIdentityRecord } from '../src/node-identity-record.js';

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

test('rate limiter refund restores a charged token without exceeding capacity', () => {
  let now = 0;
  const limiter = new PeerRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
  assert.equal(limiter.allow('peer'), true);
  assert.equal(limiter.allow('peer'), true);
  assert.equal(limiter.allow('peer'), false);
  assert.equal(limiter.refund('peer'), true);
  assert.equal(limiter.allow('peer'), true);
  assert.equal(limiter.allow('peer'), false);

  now = 1000;
  assert.equal(limiter.refund('peer', 2), true);
  assert.equal(limiter.buckets.get('peer').tokens, 2, 'refill plus refund must be capped at bucket capacity');
});

test('rate limiter refund fails closed for missing buckets, invalid costs, and invalid or regressed clocks', () => {
  let now = 100;
  const limiter = new PeerRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });
  assert.equal(limiter.refund('missing'), false);
  assert.equal(limiter.allow('peer'), true);
  const before = { ...limiter.buckets.get('peer') };

  for (const cost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 3]) {
    assert.equal(limiter.refund('peer', cost), false);
  }
  now = Number.NaN;
  assert.equal(limiter.refund('peer'), false);
  now = 99;
  assert.equal(limiter.refund('peer'), false);
  assert.deepEqual(limiter.buckets.get('peer'), before, 'failed refunds must not mutate token state');
});

test('rate limiter refund preserves the peer cardinality bound', () => {
  const limiter = new PeerRateLimiter({ capacity: 1, refillPerSecond: 1, maxPeers: 1 });
  assert.equal(limiter.allow('peer'), true);
  assert.equal(limiter.refund('peer'), true);
  assert.equal(limiter.buckets.size, 1);
  assert.equal(limiter.allow('other'), false, 'refund must not create an additional bucket');
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

function fakeIdentityKeystore() {
  const wrappingKey = Buffer.alloc(32, 0x5a);
  return {
    async createOrGetWrappingKey({ keyId, purpose }) {
      assert.match(keyId, /^zion-node-identity:/);
      assert.equal(purpose, 'zion-node-identity-dek-v1');
    },
    async wrapKey({ plaintextKey }) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
      return Buffer.concat([nonce, cipher.update(plaintextKey), cipher.final(), cipher.getAuthTag()]);
    },
    async unwrapKey({ wrappedKey }) {
      const bytes = Buffer.from(wrappedKey);
      const nonce = bytes.subarray(0, 12);
      const tag = bytes.subarray(bytes.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  };
}

test('encrypted identity record restores the same Ed25519 identity through a local keystore', async () => {
  const identity = createNodeIdentity();
  const keystore = fakeIdentityKeystore();
  const record = await createEncryptedNodeIdentityRecord(identity, keystore, {
    keyId: 'zion-node-identity:test',
    random: size => Buffer.alloc(size, size === 32 ? 0x42 : 0x24),
  });
  assert.equal(JSON.stringify(record).includes(identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), false);
  const restored = await loadEncryptedNodeIdentityRecord(record, keystore);
  assert.equal(restored.nodeId, identity.nodeId);
  assert.equal(restored.publicKeyPem, identity.publicKeyPem);
  const message = signPeerMessage(restored, { type: 'IDENTITY_RESTORE_TEST' }, { now: 1000, nonce: 'f'.repeat(32) });
  assert.equal(verifyPeerMessage(message, { now: 1000 }).ok, true);
});

test('encrypted identity record fails closed on tampering, wrong keystore and malformed schema', async () => {
  const identity = createNodeIdentity();
  const keystore = fakeIdentityKeystore();
  const record = await createEncryptedNodeIdentityRecord(identity, keystore, { keyId: 'zion-node-identity:test' });
  await assert.rejects(() => loadEncryptedNodeIdentityRecord({ ...record, ciphertext: Buffer.from('tampered').toString('base64') }, keystore));
  await assert.rejects(() => loadEncryptedNodeIdentityRecord({ ...record, nodeId: '0'.repeat(64) }, keystore));
  await assert.rejects(() => loadEncryptedNodeIdentityRecord({ ...record, extra: true }, keystore), /schema/);
  const wrong = fakeIdentityKeystore();
  wrong.unwrapKey = async () => Buffer.alloc(32, 0x99);
  await assert.rejects(() => loadEncryptedNodeIdentityRecord(record, wrong));
});

test('encrypted identity record rejects invalid adapters and oversized or malformed fields', async () => {
  const identity = createNodeIdentity();
  await assert.rejects(() => createEncryptedNodeIdentityRecord(identity, {}), /keystore/);
  const keystore = fakeIdentityKeystore();
  const record = await createEncryptedNodeIdentityRecord(identity, keystore, { keyId: 'zion-node-identity:test' });
  await assert.rejects(() => loadEncryptedNodeIdentityRecord({ ...record, nonce: 'AA==' }, keystore), /lengths/);
  await assert.rejects(() => loadEncryptedNodeIdentityRecord({ ...record, wrappedDek: '!' }, keystore), /base64/);
});
