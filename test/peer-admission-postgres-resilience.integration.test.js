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
