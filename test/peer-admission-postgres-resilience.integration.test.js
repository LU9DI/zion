import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PostgresPeerAdmissionStore } from '../src/peer-admission-postgres-store.js';

const connectionString = process.env.ZION_POSTGRES_TEST_URL;
const enabled = Boolean(connectionString);
const subjectNodeId = 'a'.repeat(64);

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

test('PostgreSQL authorization read fails closed when the pool is exhausted', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 150,
    idleTimeoutMillis: 1000,
  });
  let held;
  try {
    await applyMigration(pool);
    const store = new PostgresPeerAdmissionStore({ pool });
    held = await pool.connect();

    const result = await within(
      store.getAdmissionStatus(subjectNodeId),
      'authorization read remained queued after pool acquisition timeout',
    );
    assert.deepEqual(result, { ok: false, reason: 'admission-state-unavailable' });
  } finally {
    held?.release();
    await pool.end();
  }
});

test('PostgreSQL authorization preflight fails closed on real table-lock contention', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 1000,
    options: '-c lock_timeout=150ms -c statement_timeout=2000ms',
  });
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
    await pool.end();
  }
});

test('PostgreSQL authorization read fails closed when the configured endpoint is unreachable', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
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
