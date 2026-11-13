import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PostgresPeerAdmissionStore } from '../src/peer-admission-postgres-store.js';

const connectionString = process.env.ZION_POSTGRES_TEST_URL;
const enabled = Boolean(connectionString);
const subjectNodeId = 'a'.repeat(64);

test('PostgreSQL integration tests run against the pinned node-postgres driver', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const metadata = JSON.parse(await readFile(
    new URL('../node_modules/pg/package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(metadata.version, '8.23.1');
});

async function createIsolatedPool(schema, poolOptions = {}) {
  const { Pool } = await import('pg');
  const admin = new Pool({ connectionString });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const options = [`-c search_path=${schema}`, poolOptions.options].filter(Boolean).join(' ');
  const pool = new Pool({ connectionString, ...poolOptions, options });
  return {
    pool,
    async cleanup() {
      await pool.end();
      const cleanupPool = new Pool({ connectionString });
      try {
        await cleanupPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanupPool.end();
      }
    },
  };
}

async function applyMigration(pool) {
  const migration = await readFile(
    new URL('../migrations/postgres/0001_peer_admission.sql', import.meta.url),
    'utf8',
  );
  await pool.query(migration);
}

async function within(promise, message, ms = 2500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('PostgreSQL authorization checkout fails closed when the pool queue timeout expires', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const isolated = await createIsolatedPool('zion_pool_queue_timeout_test', {
    max: 1,
    connectionTimeoutMillis: 150,
    idleTimeoutMillis: 1000,
  });
  const { pool } = isolated;
  let held;
  try {
    await applyMigration(pool);
    const store = new PostgresPeerAdmissionStore({ pool });
    held = await pool.connect();

    const pendingRead = store.getAdmissionStatus(subjectNodeId);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(pool.waitingCount, 1, 'the authorization checkout must enter the pool queue');
    const result = await within(
      pendingRead,
      'authorization checkout did not respect connectionTimeoutMillis',
    );
    assert.deepEqual(result, { ok: false, reason: 'admission-state-unavailable' });
    assert.equal(pool.waitingCount, 0, 'timed-out checkout must leave the pool queue');
    held.release();
    held = null;
  } finally {
    held?.release();
    await isolated.cleanup();
  }
});

test('PostgreSQL authorization preflight fails closed on real table-lock contention', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const isolated = await createIsolatedPool('zion_lock_contention_test', {
    max: 2,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 1000,
    options: '-c lock_timeout=150ms -c statement_timeout=2000ms',
  });
  const { pool } = isolated;
  let blocker;
  try {
    await applyMigration(pool);
    blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE peer_admissions IN ACCESS EXCLUSIVE MODE');

    const store = new PostgresPeerAdmissionStore({ pool });
    const startedAt = Date.now();
    const result = await within(
      store.getAdmissionStatus(subjectNodeId),
      'authorization preflight did not respect PostgreSQL lock/statement timeout',
    );
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result, { ok: false, reason: 'admission-state-unavailable' });
    assert.ok(elapsedMs < 2000, `authorization read exceeded bounded wait: ${elapsedMs}ms`);
  } finally {
    if (blocker) {
      try { await blocker.query('ROLLBACK'); } catch { /* preserve the test result */ }
      blocker.release();
    }
    await isolated.cleanup();
  }
});

test('PostgreSQL authorization read fails closed when the configured endpoint is unreachable', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const { Pool } = await import('pg');
  const unreachable = new URL(connectionString);
  unreachable.port = '1';
  const pool = new Pool({
    connectionString: unreachable.toString(),
    max: 1,
    connectionTimeoutMillis: 250,
    idleTimeoutMillis: 1000,
  });
  try {
    const store = new PostgresPeerAdmissionStore({ pool });
    const result = await within(
      store.getAdmissionStatus(subjectNodeId),
      'authorization read did not fail closed for an unreachable PostgreSQL endpoint',
    );
    assert.deepEqual(result, { ok: false, reason: 'admission-state-unavailable' });
  } finally {
    await pool.end();
  }
});

test('a revocation notification missed during listener downtime cannot authorize a later frame', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const { PostgresPeerRevocationListener } = await import('../src/peer-admission-postgres-listener.js');
  const isolated = await createIsolatedPool('zion_listener_gap_authorization_test', {
    max: 3,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 1000,
  });
  const { pool } = isolated;
  const store = new PostgresPeerAdmissionStore({ pool });
  const received = [];
  const listener = new PostgresPeerRevocationListener({
    pool,
    onRevocation: nodeId => received.push(nodeId),
    minReconnectMs: 10,
    maxReconnectMs: 20,
  });
  const revokedNodeId = 'b'.repeat(64);

  try {
    await applyMigration(pool);
    await listener.start();
    await listener.stop();

    // The durable transition commits while LISTEN is offline, so its NOTIFY
    // is intentionally missed by this process.
    const revoked = await store.revokeAdmission(revokedNodeId);
    assert.deepEqual(
      { ok: revoked.ok, changed: revoked.changed, status: revoked.status, tombstone: revoked.tombstone },
      { ok: true, changed: true, status: 'revoked', tombstone: true },
    );

    await listener.start();
    assert.deepEqual(received, [], 'LISTEN must not pretend to replay notifications sent during downtime');

    // A subsequent application-frame fence must consult PostgreSQL directly;
    // notification delivery is never the authorization boundary.
    const dispatch = await store.withPeerAuthorizationFence(
      revokedNodeId,
      { allowUnadmitted: true },
      async () => 'must-not-dispatch',
    );
    assert.deepEqual(dispatch, { ok: true, admitted: false, status: 'revoked' });
    assert.deepEqual(await store.getAdmissionStatus(revokedNodeId), {
      ok: true,
      subjectNodeId: revokedNodeId,
      status: 'revoked',
    });
  } finally {
    await listener.stop();
    await isolated.cleanup();
  }
});


test('revocation serializes with an in-flight trusted-allowlist dispatch', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const isolated = await createIsolatedPool('zion_allowlist_revoke_fence_race_test', {
    max: 3,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 1000,
  });
  const { pool } = isolated;
  const store = new PostgresPeerAdmissionStore({ pool });
  const trustedNodeId = 'c'.repeat(64);
  let markDispatchStarted;
  let releaseDispatch;
  const dispatchStarted = new Promise(resolve => { markDispatchStarted = resolve; });
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });

  try {
    await applyMigration(pool);

    // This identity has no admission row and is authorized only by the
    // bootstrap allowlist. Its dispatch must still share the durable fence.
    const inFlightDispatch = store.withPeerAuthorizationFence(
      trustedNodeId,
      { allowUnadmitted: true },
      async () => {
        markDispatchStarted();
        await dispatchGate;
        return 'trusted-frame-dispatched';
      },
    );
    await within(dispatchStarted, 'trusted dispatch did not acquire its authorization fence');

    let revocationFinished = false;
    const revocation = store.revokeAdmission(trustedNodeId).then(result => {
      revocationFinished = true;
      return result;
    });

    let observedLockWait = false;
    const waitDeadline = Date.now() + 2000;
    while (!observedLockWait && Date.now() < waitDeadline) {
      const { rows } = await pool.query(
        "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'",
      );
      observedLockWait = Number(rows[0]?.count ?? 0) > 0;
      if (!observedLockWait) await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(observedLockWait, true,
      'revocation must wait for the trusted-allowlist dispatch shared advisory lock');
    assert.equal(revocationFinished, false,
      'revocation must not commit while the authorized dispatch is still running');

    releaseDispatch();
    assert.deepEqual(await within(inFlightDispatch, 'trusted dispatch did not finish'), {
      ok: true,
      admitted: true,
      status: 'trusted-allowlist',
      value: 'trusted-frame-dispatched',
    });
    assert.deepEqual(
      { ...(await within(revocation, 'revocation did not finish')) },
      { ok: true, changed: true, subjectNodeId: trustedNodeId, status: 'revoked', tombstone: true },
    );

    const laterFrame = await store.withPeerAuthorizationFence(
      trustedNodeId,
      { allowUnadmitted: true },
      async () => 'must-not-dispatch',
    );
    assert.deepEqual(laterFrame, { ok: true, admitted: false, status: 'revoked' });
  } finally {
    releaseDispatch();
    await isolated.cleanup();
  }
});


test('official transport dispatch is fenced against PostgreSQL revocation for a trusted bootstrap peer', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const { createNodeIdentity } = await import('../src/peer-security.js');
  const { createPostgresPeerAdmissionRuntime } = await import('../src/postgres-peer-admission-runtime.js');
  const { PeerTransport } = await import('../src/peer-transport.js');
  const isolated = await createIsolatedPool('zion_official_transport_revoke_race_test', {
    max: 4,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 1000,
  });
  const { pool } = isolated;
  const serverIdentity = createNodeIdentity();
  const peerIdentity = createNodeIdentity();
  const genesis = {
    schemaVersion: 1, networkName: 'Zion PostgreSQL integration', protocolMajor: 1,
    genesisTime: 1800000000, serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 32, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
  const quarantineListeners = new Set();
  const integrityGuard = {
    status: { verified: true, quarantined: false },
    async checkHealthy() {},
    assertHealthy() {
      if (this.status.quarantined) throw new Error('integrity quarantined');
    },
    addQuarantineListener(listener) {
      quarantineListeners.add(listener);
      return () => quarantineListeners.delete(listener);
    },
  };
  let markDispatchStarted;
  let releaseDispatch;
  const dispatchStarted = new Promise(resolve => { markDispatchStarted = resolve; });
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  let dispatchCount = 0;
  let runtime;
  let clientSocket;

  try {
    await applyMigration(pool);
    runtime = createPostgresPeerAdmissionRuntime({
      pool,
      controllerOptions: {
        trustedIssuerNodeIds: [],
        capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 1 }),
      },
      transportOptions: {
        identity: serverIdentity,
        protocolGenesis: genesis,
        integrityGuard,
        trustedPeerIds: [peerIdentity.nodeId],
        host: '127.0.0.1',
        port: 0,
        handlerTimeoutMs: 5000,
        onMessage: async () => {
          dispatchCount++;
          markDispatchStarted();
          await dispatchGate;
        },
      },
    });

    const address = await runtime.transport.listen();
    const client = new PeerTransport({ identity: peerIdentity, protocolGenesis: genesis });
    clientSocket = await client.connect('127.0.0.1', address.port);
    const handshakeDeadline = Date.now() + 2000;
    while ((!clientSocket.__zionSession?.authenticated ||
      ![...runtime.transport.connections].some(socket => socket.__zionSession?.authenticated)) &&
      Date.now() < handshakeDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(clientSocket.__zionSession?.authenticated, true, 'trusted bootstrap peer must complete handshake');

    client.send(clientSocket, { type: 'PING', nonce: 'official-revoke-race' });
    await within(dispatchStarted, 'official transport did not enter the application handler');

    let revocationFinished = false;
    const revocation = runtime.admissionController.revoke(peerIdentity.nodeId).then(result => {
      revocationFinished = true;
      return result;
    });

    let observedLockWait = false;
    const waitDeadline = Date.now() + 2000;
    while (!observedLockWait && Date.now() < waitDeadline) {
      const { rows } = await pool.query(
        "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'",
      );
      observedLockWait = Number(rows[0]?.count ?? 0) > 0;
      if (!observedLockWait) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(observedLockWait, true,
      'official transport revocation must wait on the dispatch shared advisory lock');
    assert.equal(revocationFinished, false,
      'durable revocation must not commit while the application handler is in flight');

    releaseDispatch();
    const revoked = await within(revocation, 'official transport revocation did not finish');
    assert.deepEqual(
      { ok: revoked.ok, changed: revoked.changed, status: revoked.status, tombstone: revoked.tombstone },
      { ok: true, changed: true, status: 'revoked', tombstone: true },
    );
    assert.equal(dispatchCount, 1, 'the already-authorized handler runs exactly once');

    // Reconnect using the same static bootstrap identity. The durable tombstone
    // must override the allowlist even if the notification path raced or was missed.
    clientSocket.destroy();
    const reconnectingClient = new PeerTransport({ identity: peerIdentity, protocolGenesis: genesis });
    clientSocket = await reconnectingClient.connect('127.0.0.1', address.port);
    const closeDeadline = Date.now() + 2000;
    while (!clientSocket.destroyed && Date.now() < closeDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(clientSocket.destroyed, true,
      'a revoked bootstrap identity must not complete a later authenticated session');
    assert.equal(dispatchCount, 1, 'revoked peer must never reach the application handler again');
  } finally {
    releaseDispatch();
    clientSocket?.destroy();
    if (runtime) await runtime.transport.close().catch(() => {});
    await isolated.cleanup();
  }
});
