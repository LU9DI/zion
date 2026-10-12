import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPostgresMigrations } from '../scripts/migrate-postgres.js';

function fakePool({ initial = {}, failMigration = false, failLock = false, failUnlock = false, failRollback = false } = {}) {
  const calls = [];
  const ledger = new Map(Object.entries(initial));
  let released = false;
  let releaseError;
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (normalized.startsWith('SELECT pg_advisory_lock')) {
        if (failLock) throw new Error('simulated advisory lock acquisition failure');
        return { rows: [{ pg_advisory_lock: null }] };
      }
      if (normalized.startsWith('SELECT pg_advisory_unlock')) {
        if (failUnlock) throw new Error('simulated advisory unlock failure');
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (normalized === 'ROLLBACK' && failRollback) {
        throw new Error('simulated rollback failure');
      }
      if (normalized.startsWith('SELECT sha256 FROM zion_schema_migrations')) {
        const sha256 = ledger.get(params[0]);
        return { rows: sha256 ? [{ sha256 }] : [] };
      }
      if (normalized.startsWith('INSERT INTO zion_schema_migrations')) {
        ledger.set(params[0], params[1]);
        return { rows: [] };
      }
      if (failMigration && normalized.includes('CREATE TABLE should_fail')) {
        throw new Error('simulated DDL failure');
      }
      return { rows: [] };
    },
    release(error) { released = true; releaseError = error; },
  };
  return {
    calls, ledger, get released() { return released; }, get releaseError() { return releaseError; },
    async connect() { return client; },
  };
}

async function withMigration(sql, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'zion-migration-test-'));
  const path = join(directory, 'migration.sql');
  await writeFile(path, sql, 'utf8');
  try { return await callback(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('migration runner applies SQL and records checksum in the same transaction', async () => {
  await withMigration('-- migration header\nBEGIN; CREATE TABLE example (id integer); COMMIT;', async path => {
    const pool = fakePool();
    const result = await runPostgresMigrations({ pool, migrations: [{ id: '0001_example', path }] });
    assert.deepEqual(result, { ok: true, migrations: [{ id: '0001_example', status: 'applied' }] });
    const sql = pool.calls.map(call => call.sql);
    assert.ok(sql.includes('BEGIN'));
    assert.ok(sql.includes('CREATE TABLE example (id integer);'));
    assert.ok(sql.some(value => value.startsWith('INSERT INTO zion_schema_migrations')));
    assert.ok(sql.includes('COMMIT'));
    assert.ok(sql.includes('SELECT pg_advisory_unlock($1)'));
    assert.equal(pool.released, true);
  });
});

test('migration runner skips a matching applied checksum', async () => {
  await withMigration('BEGIN; CREATE TABLE example (id integer); COMMIT;', async path => {
    const { createHash } = await import('node:crypto');
    const sql = 'BEGIN; CREATE TABLE example (id integer); COMMIT;';
    const checksum = createHash('sha256').update(sql).digest('hex');
    const pool = fakePool({ initial: { '0001_example': checksum } });
    const result = await runPostgresMigrations({ pool, migrations: [{ id: '0001_example', path }] });
    assert.equal(result.migrations[0].status, 'already-applied');
    assert.ok(!pool.calls.some(call => call.sql === 'BEGIN'));
  });
});

test('migration runner rejects edits to an already-applied migration', async () => {
  await withMigration('BEGIN; CREATE TABLE example (id integer); COMMIT;', async path => {
    const pool = fakePool({ initial: { '0001_example': '0'.repeat(64) } });
    await assert.rejects(
      runPostgresMigrations({ pool, migrations: [{ id: '0001_example', path }] }),
      { code: 'ZION_MIGRATION_CHECKSUM_MISMATCH' },
    );
    assert.ok(!pool.calls.some(call => call.sql === 'BEGIN'));
    assert.equal(pool.released, true);
  });
});

test('migration runner rolls back DDL failures and releases the client', async () => {
  await withMigration('BEGIN; CREATE TABLE should_fail (id integer); COMMIT;', async path => {
    const pool = fakePool({ failMigration: true });
    await assert.rejects(
      runPostgresMigrations({ pool, migrations: [{ id: '0001_failure', path }] }),
      /simulated DDL failure/,
    );
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(!pool.ledger.has('0001_failure'));
    assert.equal(pool.released, true);
  });
});

test('migration runner discards a client when rollback after migration failure fails', async () => {
  await withMigration('BEGIN; CREATE TABLE should_fail (id integer); COMMIT;', async path => {
    const pool = fakePool({ failMigration: true, failRollback: true });
    await assert.rejects(
      runPostgresMigrations({ pool, migrations: [{ id: '0001_failure', path }] }),
      /simulated DDL failure/,
    );
    assert.equal(pool.released, true);
    assert.match(pool.releaseError?.message ?? '', /simulated rollback failure/);
    assert.ok(!pool.ledger.has('0001_failure'));
  });
});

test('migration runner validates migration IDs before connecting', async () => {
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error('must not connect'); } };
  await assert.rejects(
    runPostgresMigrations({ pool, migrations: [{ id: '../unsafe', path: '/tmp/nope' }] }),
    /safe IDs/,
  );
  assert.equal(connected, false);
});

test('migration runner rejects duplicate migration IDs before connecting', async () => {
  let connected = false;
  const pool = { async connect() { connected = true; throw new Error('must not connect'); } };
  await assert.rejects(
    runPostgresMigrations({
      pool,
      migrations: [
        { id: '0001_example', path: '/tmp/first.sql' },
        { id: '0001_example', path: '/tmp/second.sql' },
      ],
    }),
    /IDs must be unique/,
  );
  assert.equal(connected, false);
});

test('migration runner discards a client when advisory lock release cannot be confirmed', async () => {
  await withMigration('BEGIN; CREATE TABLE example (id integer); COMMIT;', async path => {
    const pool = fakePool({ failUnlock: true });
    await assert.rejects(
      runPostgresMigrations({ pool, migrations: [{ id: '0001_example', path }] }),
      { code: 'ZION_MIGRATION_LOCK_RELEASE_FAILED' },
    );
    assert.equal(pool.released, true);
    assert.match(pool.releaseError?.message ?? '', /advisory unlock failure/);
    assert.ok(pool.ledger.has('0001_example'));
  });
});


test('migration runner discards a client when advisory lock acquisition is ambiguous', async () => {
  await withMigration('BEGIN; CREATE TABLE example (id integer); COMMIT;', async path => {
    const pool = fakePool({ failLock: true });
    await assert.rejects(
      runPostgresMigrations({ pool, migrations: [{ id: '0001_example', path }] }),
      /simulated advisory lock acquisition failure/,
    );
    assert.equal(pool.released, true);
    assert.match(pool.releaseError?.message ?? '', /acquisition was not confirmed/);
    assert.ok(!pool.ledger.has('0001_example'));
  });
});
