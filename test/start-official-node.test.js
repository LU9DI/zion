import test from 'node:test';
import assert from 'node:assert/strict';
import { startOfficialNode } from '../scripts/start-official-node.js';

test('official launcher rejects a missing deployment adapter before loading modules', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: { ZION_POSTGRES_URL: 'postgres://unused' },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /ZION_OFFICIAL_ADAPTER_MODULE/,
  );
  assert.equal(loaded, false);
});

test('official launcher requires a PostgreSQL URL before loading deployment code', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: { ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs' },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /ZION_POSTGRES_URL/,
  );
  assert.equal(loaded, false);
});

test('official launcher rejects invalid pool bounds before loading deployment code', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
        ZION_POSTGRES_POOL_MAX: '101',
      },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /ZION_POSTGRES_POOL_MAX/,
  );
  assert.equal(loaded, false);
});


test('official launcher rejects a pool too small for the dedicated revocation listener', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
        ZION_POSTGRES_POOL_MAX: '1',
      },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /between 2 and 100.*revocation listener/,
  );
  assert.equal(loaded, false);
});

test('official launcher closes the PostgreSQL pool when adapter validation fails', async () => {
  let poolClosed = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
      },
      loadAdapterModule: async () => ({
        createPool: async () => ({
          connect: async () => ({}),
          end: async () => { poolClosed = true; },
        }),
        createOfficialNodeDependencies: async () => ({}),
      }),
    }),
    /complete IntegrityGuard/,
  );
  assert.equal(poolClosed, true);
});

test('official launcher closes a partially invalid PostgreSQL pool', async () => {
  let poolClosed = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
      },
      loadAdapterModule: async () => ({
        createPool: async () => ({
          end: async () => { poolClosed = true; },
        }),
        createOfficialNodeDependencies: async () => ({}),
      }),
    }),
    /pg-compatible pool/,
  );
  assert.equal(poolClosed, true);
});


test('official launcher starts the composed node and closes transport, storage, listener, and pool', async () => {
  const { EventEmitter } = await import('node:events');
  const { createNodeIdentity } = await import('../src/peer-security.js');
  const lifecycle = [];
  const clients = [];
  let storageRunning = false;
  let poolEnded = false;
  let poolOptions;
  let dependencyOptions;

  const guard = {
    status: { quarantined: false, verified: true },
    async verify() { lifecycle.push('integrity-verify'); return { ok: true }; },
    async checkHealthy() { lifecycle.push('integrity-check'); },
    assertHealthy() {},
    addQuarantineListener() { return () => {}; },
  };
  const identity = createNodeIdentity();
  const genesis = {
    schemaVersion: 1, networkName: 'Zion launcher test network', protocolMajor: 1, genesisTime: 1800000000,
    serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 32, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };

  const running = await startOfficialNode({
    env: {
      ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/test-adapter.mjs',
      ZION_POSTGRES_URL: 'postgres://zion-test.invalid/zion',
    },
    async loadAdapterModule() {
      return {
        async createPool(options) {
          poolOptions = options;
          return {
            async connect() {
              const client = new EventEmitter();
              client.queries = [];
              client.query = async sql => { client.queries.push(sql); return { rows: [] }; };
              client.release = () => { lifecycle.push('listener-release'); };
              clients.push(client);
              return client;
            },
            async end() { poolEnded = true; lifecycle.push('pool-end'); },
          };
        },
        async createOfficialNodeDependencies(options) {
          dependencyOptions = options;
          return {
            integrityGuard: guard,
            identity,
            protocolGenesis: genesis,
            trustedPeerIds: [identity.nodeId],
            async startStorage() { storageRunning = true; lifecycle.push('storage-start'); },
            async stopStorage() { storageRunning = false; lifecycle.push('storage-stop'); },
            async getStorageStatus() { return { running: storageRunning }; },
            controllerOptions: {
              trustedIssuerNodeIds: ['1'.repeat(64)],
              capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 0.5 }),
            },
            transportOptions: { host: '127.0.0.1', port: 0, onMessage: async () => {} },
          };
        },
      };
    },
  });

  assert.equal(running.ok, true);
  assert.equal(running.integrity, guard.status);
  assert.equal(running.address.host, '127.0.0.1');
  assert.ok(running.address.port > 0);
  assert.equal(poolOptions.connectionString, 'postgres://zion-test.invalid/zion');
  assert.equal(poolOptions.max, 10);
  assert.equal(dependencyOptions.pool instanceof Object, true);
  assert.equal(storageRunning, true);
  assert.equal(running.runtime.revocationListener.running, true);
  assert.deepEqual(clients[0].queries, ['LISTEN zion_peer_revocations']);

  await running.close();

  assert.equal(storageRunning, false);
  assert.equal(running.runtime.revocationListener.running, false);
  assert.deepEqual(clients[0].queries, ['LISTEN zion_peer_revocations', 'UNLISTEN zion_peer_revocations']);
  assert.ok(lifecycle.includes('listener-release'));
  assert.equal(poolEnded, true);
  assert.equal(running.bootstrap.containmentReport.transport, 'unknown');
  assert.equal(running.bootstrap.containmentReport.storage, 'stopped');
  assert.equal(running.bootstrap.containmentReport.verifiedStopped, false);
  assert.ok(lifecycle.indexOf('storage-stop') < lifecycle.indexOf('pool-end'));
});
