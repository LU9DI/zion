import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialPostgresAdmissionTransport } from '../src/official-postgres-admission-transport.js';
import { createNodeIdentity } from '../src/peer-security.js';

const id = digit => digit.repeat(64);

function fixture(overrides = {}) {
  const pool = { async connect() { throw new Error('not used by constructor test'); } };
  const integrityGuard = {
    status: { verified: true, quarantined: false },
    async checkHealthy() {},
    assertHealthy() {},
    addQuarantineListener() { return () => {}; },
  };
  const protocolGenesis = {
    schemaVersion: 1, networkName: 'Zion Test Network', protocolMajor: 1,
    genesisTime: 1800000000, serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 16, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
  return {
    pool, identity: createNodeIdentity(), integrityGuard, protocolGenesis,
    trustedPeerIds: [id('a')],
    trustedIssuerNodeIds: [id('1'), id('2')],
    storageHeadroomProvider: async () => 0.5,
    ...overrides,
  };
}

test('official composition injects verified PostgreSQL admission, not the raw store', async t => {
  const composed = createOfficialPostgresAdmissionTransport(fixture());
  t.after(() => composed.transport.close());
  assert.equal(composed.transport.networkMode, 'official');
  assert.equal(composed.transport.admissionController, composed.admissionService);
  assert.equal(composed.admissionService.store, composed.store);
  assert.equal(typeof composed.admissionService.admit, 'function');
  assert.equal(typeof composed.admissionService.isAdmitted, 'function');
  assert.equal(typeof composed.admissionService.releaseAdmission, 'function');
});

test('official composition refuses security-critical overrides that could bypass admission', () => {
  assert.throws(() => createOfficialPostgresAdmissionTransport(fixture({
    transportOptions: { admissionController: { admit() {}, isAdmitted() {} } },
  })), /Security-critical transport options/);
  assert.throws(() => createOfficialPostgresAdmissionTransport(fixture({
    transportOptions: { networkMode: 'legacy' },
  })), /Security-critical transport options/);
});

test('official composition fails closed when trusted issuers cannot satisfy threshold', () => {
  assert.throws(() => createOfficialPostgresAdmissionTransport(fixture({
    trustedIssuerNodeIds: [id('1')],
  })), /Invalid verified PostgreSQL admission configuration/);
});

test('official composition does not allow option spreads to replace the injected pool or store', async t => {
  const originalPool = { async connect() { throw new Error('not used by constructor test'); } };
  const attackerPool = { async connect() { throw new Error('unexpected pool'); } };
  const originalStore = {
    async commitAdmission() { return { ok: true }; },
    async isAdmitted() { return false; },
    async releaseAdmission() { return { ok: true }; },
  };
  const composed = createOfficialPostgresAdmissionTransport(fixture({
    pool: originalPool,
    storeOptions: { pool: attackerPool },
    admissionOptions: { store: originalStore, trustedIssuerNodeIds: [id('9')], storageHeadroomProvider: async () => 0 },
  }));
  t.after(() => composed.transport.close());
  assert.equal(composed.store.pool, originalPool);
  assert.equal(composed.admissionService.store, composed.store);
  assert.deepEqual(composed.admissionService.trustedIssuerNodeIds, [id('1'), id('2')]);
  assert.equal(await composed.admissionService.storageHeadroomProvider(), 0.5);
});
