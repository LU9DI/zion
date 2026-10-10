import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { GossipRelay } from '../src/gossip-relay.js';

const chunk = 'b'.repeat(64);

test('gossip verifies origin signature, deduplicates and decrements hop count without invalidating signature', () => {
  let now = 1000;
  const identity = createNodeIdentity();
  const source = new GossipRelay({ now: () => now });
  const event = source.create({ identity, type: 'chunk-available', chunkId: chunk, ttlMs: 5000, hopsRemaining: 3 });
  const relay = new GossipRelay({ now: () => now });
  const accepted = relay.accept(event);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.forward.hopsRemaining, 2);
  const downstream = new GossipRelay({ now: () => now });
  const forwarded = downstream.accept(accepted.forward);
  assert.equal(forwarded.accepted, true, 'origin signature remains valid when hop budget changes');
  assert.equal(forwarded.forward.hopsRemaining, 1);
  assert.equal(relay.accept(event).reason, 'duplicate');
  now += 6000;
  assert.equal(relay.accept(event).reason, 'expired-event');
});

test('gossip rejects payload tampering, origin substitution and invalid hop metadata', () => {
  const identity = createNodeIdentity();
  const otherIdentity = createNodeIdentity();
  const source = new GossipRelay({ now: () => 1000 });
  const event = source.create({ identity, type: 'chunk-available', chunkId: chunk });
  const relay = new GossipRelay({ now: () => 1000 });
  assert.equal(relay.accept({ ...event, chunkId: 'c'.repeat(64) }).reason, 'invalid-event');
  assert.equal(relay.accept({ ...event, originId: otherIdentity.nodeId }).reason, 'invalid-event');
  assert.equal(relay.accept({ ...event, hopsRemaining: 99 }).reason, 'invalid-event');
  assert.equal(relay.accept({ ...event, unknown: true }).reason, 'invalid-event');
  assert.equal(relay.accept({ ...event, originSignature: Buffer.from('forged').toString('base64') }).reason, 'invalid-event');
});

test('gossip fails closed on malformed fields and bounded-cache overflow', () => {
  const identity = createNodeIdentity();
  const source = new GossipRelay({ now: () => 1000 });
  const first = source.create({ identity, type: 'peer-seen' });
  const other = new GossipRelay({ maxEvents: 1, now: () => 1000 });
  assert.equal(other.accept(first).accepted, true);
  assert.equal(other.accept(first).reason, 'duplicate');
  const second = new GossipRelay({ now: () => 1001 }).create({ identity, type: 'peer-expired', peerId: 'c'.repeat(64) });
  assert.equal(other.accept(second).reason, 'capacity');
});

test('gossip rejects invalid identity and malformed event creation arguments', () => {
  const relay = new GossipRelay({ now: () => 1000 });
  assert.throws(() => relay.create({ originId: 'a'.repeat(64), type: 'peer-seen' }), /identity/);
  assert.throws(() => relay.create({ identity: createNodeIdentity(), type: 'not-allowed' }), /Unsupported/);
  assert.throws(() => relay.create({ identity: createNodeIdentity(), type: 'peer-seen', hopsRemaining: 99 }), /TTL or hop/);
});
