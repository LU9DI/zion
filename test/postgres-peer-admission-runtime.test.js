import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPostgresPeerAdmissionRuntime } from '../src/postgres-peer-admission-runtime.js';
import { PostgresPeerAdmissionController } from '../src/peer-admission-postgres-controller.js';
import { PostgresPeerRevocationListener } from '../src/peer-admission-postgres-listener.js';
import { PostgresPeerAdmissionStore } from '../src/peer-admission-postgres-store.js';

const id = digit => digit.repeat(64);

function testGenesis() {
  return {
    schemaVersion: 1, networkName: 'Zion test network', protocolMajor: 1, genesisTime: 1800000000,
    serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 32, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
}

function integrityGuard() {
  return {
    status: { quarantined: false },
    checkHealthy: async () => {},
    assertHealthy() {},
    addQuarantineListener() { return () => {}; },
  };
}

test('PostgreSQL runtime composes store, controller, listener, and official transport', async () => {
  const pool = { async connect() { throw new Error('listener must not connect before transport.listen'); } };
  const identity = createNodeIdentity();
  const runtime = createPostgresPeerAdmissionRuntime({
    pool,
    controllerOptions: {
      trustedIssuerNodeIds: [id('1')],
      capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 0.5 }),
    },
    transportOptions: {
      identity,
      integrityGuard: integrityGuard(),
      protocolGenesis: testGenesis(),
      trustedPeerIds: [identity.nodeId],
      onMessage: async () => {},
    },
  });

  assert.ok(runtime.store instanceof PostgresPeerAdmissionStore);
  assert.ok(runtime.admissionController instanceof PostgresPeerAdmissionController);
  assert.ok(runtime.revocationListener instanceof PostgresPeerRevocationListener);
  assert.equal(runtime.admissionController.store, runtime.store);
  assert.equal(runtime.revocationListener.pool, pool);
  assert.equal(runtime.transport.admissionController, runtime.admissionController);
  assert.equal(runtime.transport.revocationListener, runtime.revocationListener);
  assert.equal(runtime.transport.networkMode, 'official');
  await runtime.transport.close();
});

test('PostgreSQL runtime rejects legacy mode and externally supplied admission adapters', () => {
  const pool = { async connect() { throw new Error('not used'); } };
  const base = {
    pool,
    controllerOptions: {
      trustedIssuerNodeIds: [id('1')],
      capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 0.5 }),
    },
  };
  assert.throws(() => createPostgresPeerAdmissionRuntime({
    ...base, transportOptions: { networkMode: 'legacy' },
  }), /official transport mode/);
  assert.throws(() => createPostgresPeerAdmissionRuntime({
    ...base, transportOptions: { admissionController: {}, revocationListener: {} },
  }), /managed by this runtime/);
});
