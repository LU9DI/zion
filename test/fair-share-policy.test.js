import test from 'node:test';
import assert from 'node:assert/strict';
import { FairSharePolicy, PeerAbuseGuard, PersistentPeerAbuseGuard } from '../src/fair-share-policy.js';
import { createNodeIdentity } from '../src/peer-security.js';

const id = () => createNodeIdentity().nodeId;
const chunk = bytes => ({ ownerId: id(), bytes, personalStoredBytes: 0 });

test('personal quota is bounded by configured cap and verified contribution ratio', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 0.5 });
  assert.equal(policy.setVerifiedContributionBytes(600), 300);
  assert.equal(policy.setVerifiedContributionBytes(5000), 1000);
  assert.equal(policy.setVerifiedContributionBytes(0), 0);
});

test('contribution credit expires unless fresh inventory evidence is renewed', () => {
  let now = 1_000_000;
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 0.5, contributionTtlMs: 2000, now: () => now });
  assert.equal(policy.setVerifiedContributionBytes(800), 400);
  now += 2001;
  assert.equal(policy.personalQuotaBytes(), 0);
  assert.equal(policy.snapshot().contributionEvidenceFresh, false);
  now += 1;
  assert.equal(policy.setVerifiedContributionBytes(600), 300);
  assert.equal(policy.personalQuotaBytes(), 300);
});

test('clock rollback expires contribution evidence instead of extending its lifetime', () => {
  let now = 2_000_000;
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, now: () => now });
  policy.setVerifiedContributionBytes(500);
  now -= 1;
  assert.equal(policy.personalQuotaBytes(), 0);
});

test('explicit contribution revocation immediately removes personal quota', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1 });
  policy.setVerifiedContributionBytes(500);
  assert.equal(policy.personalQuotaBytes(), 500);
  assert.equal(policy.revokeVerifiedContribution(), 0);
  assert.equal(policy.personalQuotaBytes(), 0);
});

test('rejects personal storage when contribution credit is zero', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, maxChunkBytes: 1000 });
  assert.equal(policy.reserve(chunk(100)).reason, 'personal-quota-exceeded');
});

test('allows within quota and commits one reservation only once', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, maxChunkBytes: 1000 });
  policy.setVerifiedContributionBytes(500);
  const result = policy.reserve(chunk(100));
  assert.equal(result.ok, true);
  assert.equal(result.reservation.commit(), true);
  assert.equal(result.reservation.commit(), false);
  assert.equal(policy.snapshot().dailyUploadBytes, 100);
  assert.equal(policy.snapshot().activeRequests, 0);
});

test('reserves bytes atomically across concurrent pending requests', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, maxChunkBytes: 1000 });
  policy.setVerifiedContributionBytes(150);
  const a = policy.reserve(chunk(100));
  const b = policy.reserve(chunk(100));
  assert.equal(a.ok, true);
  assert.equal(b.reason, 'personal-quota-exceeded');
  a.reservation.release();
  assert.equal(policy.reserve(chunk(100)).ok, true);
});

test('enforces daily upload and request limits', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, maxDailyUploadBytes: 100, maxDailyRequests: 1, maxChunkBytes: 1000 });
  policy.setVerifiedContributionBytes(1000);
  const a = policy.reserve(chunk(80));
  assert.equal(a.ok, true);
  a.reservation.commit();
  assert.equal(policy.reserve(chunk(40)).reason, 'daily-request-limit');
});

test('enforces concurrent request limit and releases failed reservations', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, maxConcurrentRequests: 1, maxChunkBytes: 1000 });
  policy.setVerifiedContributionBytes(1000);
  const a = policy.reserve(chunk(100));
  assert.equal(policy.reserve(chunk(100)).reason, 'concurrency-limit');
  a.reservation.release();
  assert.equal(policy.reserve(chunk(100)).ok, true);
});

test('rolls daily counters at UTC epoch day boundary', () => {
  let now = 86_400_000 - 1;
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, maxDailyRequests: 2, maxChunkBytes: 1000, now: () => now });
  policy.setVerifiedContributionBytes(1000);
  const a = policy.reserve(chunk(100)); a.reservation.commit();
  now = 86_400_000;
  assert.equal(policy.snapshot().dailyUploadBytes, 0);
  assert.equal(policy.snapshot().dailyRequests, 0);
});

test('rejects invalid identities and malformed accounting inputs', () => {
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 1, maxChunkBytes: 1000 });
  assert.equal(policy.reserve({ ownerId: 'not-an-id', bytes: 100 }).reason, 'invalid-owner');
  assert.equal(policy.reserve({ ownerId: id(), bytes: 100, personalStoredBytes: -1 }).reason, 'invalid-storage-accounting');
  assert.throws(() => policy.setVerifiedContributionBytes(-1), /Contribution/);
});

test('peer abuse guard caps per-identity bytes and concurrency', () => {
  const guard = new PeerAbuseGuard({ maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 3, maxConcurrentPerPeer: 1 });
  const peer = id();
  const a = guard.reserve(peer, 80);
  assert.equal(a.ok, true);
  assert.equal(guard.reserve(peer, 10).reason, 'peer-concurrency-limit');
  a.commit();
  assert.equal(guard.reserve(peer, 30).reason, 'peer-daily-byte-limit');
});

test('peer abuse guard rejects new identities after bounded peer table fills', () => {
  const guard = new PeerAbuseGuard({ maxPeers: 1 });
  assert.equal(guard.reserve(id(), 10).ok, true);
  assert.equal(guard.reserve(id(), 10).reason, 'peer-capacity-or-identity-limit');
});

test('coordinator rejects uploads before contacting peers when fair-share quota is exhausted', async () => {
  const { ReplicationCoordinator } = await import('../src/replication-coordinator.js');
  const identity = createNodeIdentity();
  const policy = new FairSharePolicy({ maxPersonalBytes: 1000, contributionRatio: 0, maxChunkBytes: 1000 });
  policy.setVerifiedContributionBytes(10_000);
  const coordinator = new ReplicationCoordinator({ identity, transport: {}, storageService: {}, fairSharePolicy: policy });
  const result = await coordinator.replicate({ envelope: Buffer.concat([Buffer.from('REAC1'), Buffer.alloc(28)]), peers: [] });
  assert.equal(result.rejected, true);
  assert.equal(result.rejectionReason, 'personal-quota-exceeded');
  assert.equal(result.attempted, 0);
});

test('coordinator accepts only a matching peer fair-use rejection', async () => {
  const { ReplicationCoordinator } = await import('../src/replication-coordinator.js');
  const owner = createNodeIdentity();
  const peer = createNodeIdentity();
  const coordinator = new ReplicationCoordinator({ identity: owner, transport: {}, storageService: {} });
  const requestId = 'a'.repeat(32); const chunkId = 'b'.repeat(64);
  let rejected;
  const receiptPromise = new Promise((resolve, reject) => { rejected = reject; });
  receiptPromise.catch(() => {});
  coordinator.waiting.set(requestId, { nodeId: peer.nodeId, chunkId, resolve: () => {}, reject: rejected });
  const result = await coordinator.handleMessage({ nodeId: peer.nodeId, payload: { type: 'STORE_REJECTED', requestId, chunkId, code: 'FAIR_USE_LIMIT', availableBytes: 0 } }, {});
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'fair-use-limit');
  await assert.rejects(receiptPromise, error => error.code === 'FAIR_USE_LIMIT');
});

test('persistent peer abuse guard keeps daily byte and request counters across restart', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-fair-share-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = id();
  const first = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 2 }).init();
  const reservation = await first.reserve(peer, 60);
  assert.equal(reservation.ok, true);
  assert.equal(await reservation.commit(), true);
  const restarted = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 2 }).init();
  assert.equal((await restarted.reserve(peer, 50)).reason, 'peer-daily-byte-limit');
  assert.equal((await restarted.reserve(peer, 1)).ok, true);
});

test('persistent peer abuse guard reserves quota atomically across concurrent callers', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-fair-share-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const peer = id();
  const a = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100 }).init();
  const b = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100 }).init();
  const results = await Promise.all([a.reserve(peer, 70), b.reserve(peer, 70)]);
  assert.equal(results.filter(x => x.ok).length, 1);
  assert.equal(results.filter(x => x.reason === 'peer-daily-byte-limit').length, 1);
  await Promise.all(results.filter(x => x.ok).map(x => x.release()));
});


test('clock rollback does not reset in-memory daily abuse limits', () => {
  let now = 5 * 86_400_000;
  const guard = new PeerAbuseGuard({ maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 10, now: () => now });
  const peer = id();
  const first = guard.reserve(peer, 80);
  assert.equal(first.ok, true);
  first.commit();
  now -= 2 * 86_400_000;
  assert.equal(guard.reserve(peer, 30).reason, 'peer-daily-byte-limit');
  now = 6 * 86_400_000;
  assert.equal(guard.reserve(peer, 30).ok, true);
});

test('persistent abuse guard does not reset quotas or delete history after clock rollback', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-clock-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 5 * 86_400_000;
  const peer = id();
  const first = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 10, now: () => now }).init();
  const reservation = await first.reserve(peer, 80);
  assert.equal(reservation.ok, true);
  await reservation.commit();
  now -= 2 * 86_400_000;
  const restarted = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 10, now: () => now }).init();
  assert.equal((await restarted.reserve(peer, 30)).reason, 'peer-daily-byte-limit');
  now = 6 * 86_400_000;
  const nextDay = await new PersistentPeerAbuseGuard(root, { maxDailyBytesPerPeer: 100, maxDailyRequestsPerPeer: 10, now: () => now }).init();
  assert.equal((await nextDay.reserve(peer, 30)).ok, true);
});

test('persistent peer abuse guard fails closed on corrupt accounting state', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const root = await mkdtemp(path.join(os.tmpdir(), 'rea-fair-share-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'peer-abuse-state.json'), '{corrupt');
  const guard = new PersistentPeerAbuseGuard(root);
  await assert.rejects(guard.init(), /refusing admission/);
  assert.equal((await guard.reserve(id(), 10)).reason, 'guard-not-initialized');
});
