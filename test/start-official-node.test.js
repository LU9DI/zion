import test from 'node:test';
import assert from 'node:assert/strict';
import { startOfficialNode } from '../scripts/start-official-node.js';
import { createNodeIdentity } from '../src/peer-security.js';

const env = Object.freeze({
  ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/deployment/official-adapter.mjs',
  ZION_POSTGRES_URL: 'postgres://unit-test.invalid/zion',
});

function poolFixture() {
  const instances = [];
  class FakePool {
    constructor(options) { this.options = options; this.ended = false; instances.push(this); }
    async end() { this.ended = true; }
  }
  return { FakePool, instances };
}

test('official launcher requires an absolute deployment-owned adapter path', async () => {
  let loaded = false;
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env: { ...env, ZION_OFFICIAL_ADAPTER_MODULE: 'relative-adapter.mjs' },
    PoolClass: FakePool,
    loadAdapterModule: async () => { loaded = true; return {}; },
  }), /absolute path/);
  assert.equal(loaded, false);
  assert.equal(instances.length, 0);
});

test('official launcher validates PostgreSQL pool bounds before loading deployment code', async () => {
  let loaded = false;
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env: { ...env, ZION_POSTGRES_POOL_MAX: '101' },
    PoolClass: FakePool,
    loadAdapterModule: async () => { loaded = true; return {}; },
  }), /between 1 and 100/);
  assert.equal(loaded, false);
  assert.equal(instances.length, 0);
});

test('official launcher refuses an adapter module without the explicit dependency factory', async () => {
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: FakePool,
    loadAdapterModule: async specifier => {
      assert.equal(specifier, 'file:///opt/zion/deployment/official-adapter.mjs');
      return {};
    },
  }), /createOfficialNodeDependencies/);
  assert.equal(instances.length, 0);
});

test('official launcher closes the pool when deployment dependencies are incomplete', async () => {
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: FakePool,
    loadAdapterModule: async () => ({
      async createOfficialNodeDependencies({ pool }) {
        assert.equal(pool, instances[0]);
        return { identity: { nodeId: 'untrusted-incomplete-fixture' } };
      },
    }),
  }), /complete IntegrityGuard/);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].options.max, 10);
  assert.equal(instances[0].options.connectionTimeoutMillis, 5000);
  assert.equal(instances[0].ended, true);
});

test('official launcher closes the pool when adapter initialization throws', async () => {
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: FakePool,
    loadAdapterModule: async () => ({
      async createOfficialNodeDependencies() { throw new Error('adapter initialization failed'); },
    }),
  }), /adapter initialization failed/);
  assert.equal(instances[0].ended, true);
});


test('official launcher composes the real transport/bootstrap and closes storage plus PostgreSQL pool', async () => {
  const state = { verified: false, quarantined: false, storageRunning: false };
  const genesis = {
    schemaVersion: 1, networkName: 'Zion Launcher Test', protocolMajor: 1,
    genesisTime: 1800000000, serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 16, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
  class IntegrationPool {
    constructor(options) { this.options = options; this.ended = false; }
    async connect() {
      return {
        async query(sql) {
          if (sql.startsWith('SELECT max_active_peers')) return { rows: [{
            max_active_peers: 10, max_admissions_per_issuer: 5,
            min_storage_headroom_ratio: 0.1, policy_version: 1,
          }] };
          if (sql.startsWith('SELECT active_reservations')) return { rows: [{ active_reservations: 0 }] };
          if (sql.includes('count(*)::bigint AS active_count')) return { rows: [{ active_count: '0' }] };
          return { rows: [] };
        },
        release() {},
      };
    }
    async end() { this.ended = true; }
  }
  let pool;
  const running = await startOfficialNode({
    env,
    PoolClass: class extends IntegrationPool {
      constructor(options) { super(options); pool = this; }
    },
    loadAdapterModule: async () => ({
      async createOfficialNodeDependencies() {
        return {
          integrityGuard: {
            get status() { return { verified: state.verified, quarantined: state.quarantined }; },
            async verify() { state.verified = true; return { ok: true }; },
            async checkHealthy() { if (!state.verified || state.quarantined) throw new Error('integrity unhealthy'); },
            assertHealthy() { if (!state.verified || state.quarantined) throw new Error('integrity unhealthy'); },
            addQuarantineListener() { return () => {}; },
          },
          identity: createNodeIdentity(),
          protocolGenesis: genesis,
          trustedPeerIds: ['a'.repeat(64)],
          trustedIssuerNodeIds: ['1'.repeat(64), '2'.repeat(64)],
          storageHeadroomProvider: async () => 0.5,
          async startStorage() { state.storageRunning = true; },
          async stopStorage() { state.storageRunning = false; },
          async getStorageStatus() { return { running: state.storageRunning }; },
          transportOptions: { host: '127.0.0.1', port: 0 },
        };
      },
    }),
  });
  assert.equal(running.ok, true);
  assert.ok(running.address.port > 0);
  assert.equal(state.storageRunning, true);
  await running.close();
  assert.equal(state.storageRunning, false);
  assert.equal(pool.ended, true);
});


test('official launcher closes composed transport and PostgreSQL pool when integrity verification fails', async () => {
  const lifecycle = { poolEnded: false, storageStarted: false };
  const genesis = {
    schemaVersion: 1, networkName: 'Zion Launcher Failure Test', protocolMajor: 1,
    genesisTime: 1800000000, serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 16, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
  class FailurePool {
    constructor() { this.ended = false; }
    async end() { this.ended = true; lifecycle.poolEnded = true; }
  }
  let pool;
  const guard = {
    status: { verified: false, quarantined: false },
    async verify() { return { ok: false, reason: 'fixture-integrity-failure' }; },
    async checkHealthy() { throw new Error('integrity not verified'); },
    assertHealthy() { throw new Error('integrity not verified'); },
    addQuarantineListener() { return () => {}; },
  };
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: class extends FailurePool { constructor(options) { super(options); pool = this; } },
    loadAdapterModule: async () => ({
      async createOfficialNodeDependencies() {
        return {
          integrityGuard: guard,
          identity: createNodeIdentity(),
          protocolGenesis: genesis,
          trustedPeerIds: ['a'.repeat(64)],
          trustedIssuerNodeIds: ['1'.repeat(64), '2'.repeat(64)],
          storageHeadroomProvider: async () => 0.5,
          async startStorage() { lifecycle.storageStarted = true; },
          async stopStorage() { lifecycle.storageStarted = false; },
          transportOptions: { host: '127.0.0.1', port: 0 },
        };
      },
    }),
  }), { code: 'ZION_STARTUP_INTEGRITY_FAILED' });
  assert.equal(lifecycle.storageStarted, false, 'storage must never start before integrity verification');
  assert.equal(pool.ended, true, 'PostgreSQL pool must close after startup failure');
  assert.equal(lifecycle.poolEnded, true);
});
