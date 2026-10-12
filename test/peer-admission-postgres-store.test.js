import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresPeerAdmissionStore } from '../src/peer-admission-postgres-store.js';

const id = digit => digit.repeat(64);
const nonce = digit => digit.repeat(32);
const input = () => ({
  subjectNodeId: id('a'),
  issuerNodeIds: [id('1'), id('2')],
  invitations: [
    { issuerNodeId: id('1'), nonce: nonce('a') },
    { issuerNodeId: id('2'), nonce: nonce('b') },
  ],
  storageHeadroomRatio: 0.5,
  maxActivePeers: 10,
  maxAdmissionsPerIssuer: 5,
});

function fakePool({ failInvitationInsert = false, retryOnce = false, failCommit = false, failRollback = false, failAdmissionRead = false, activeReservations = 0, inRecovery = false } = {}) {
  const calls = [];
  let retryPending = retryOnce;
  let commitPending = failCommit;
  return {
    calls,
    setInRecovery(value) { inRecovery = value; },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
          if (sql === 'SELECT pg_is_in_recovery() AS in_recovery') return { rows: [{ in_recovery: inRecovery }] };
          if (sql.includes('SELECT 1 AS admitted FROM peer_admissions') && failAdmissionRead) throw Object.assign(new Error('connection lost during admission read'), { code: '08006' });
          if (sql === 'ROLLBACK' && failRollback) throw Object.assign(new Error('connection lost during ROLLBACK'), { code: '08006' });
          if (sql === 'COMMIT' && commitPending) {
            commitPending = false;
            throw Object.assign(new Error('connection lost during COMMIT'), { code: '08006' });
          }
          if (sql.startsWith('SELECT max_active_peers')) {
            return { rows: [{ max_active_peers: 100, max_admissions_per_issuer: 5,
              min_storage_headroom_ratio: 0.1, policy_version: 7 }] };
          }
          if (sql.startsWith('SELECT active_reservations')) return { rows: [{ active_reservations: activeReservations }] };
          if (sql.includes('count(*)::integer')) return { rows: [{ count: 0 }] };
          if (sql.includes('count(*)::bigint AS active_count')) return { rows: [{ active_count: '0' }] };
          if (sql.startsWith('INSERT INTO consumed_peer_invitations') && failInvitationInsert) {
            throw Object.assign(new Error('duplicate invitation'), {
              code: '23505', constraint: 'consumed_peer_invitations_pkey',
            });
          }
          if (sql.startsWith('INSERT INTO peer_admissions') && retryPending) {
            retryPending = false;
            throw Object.assign(new Error('serialization failure'), { code: '40001' });
          }
          if (sql.startsWith('UPDATE peer_admissions') && sql.includes('RETURNING')) {
            return { rows: [{ subject_node_id: params[0] }] };
          }
          return { rows: [] };
        },
        release(error) { calls.push({ sql: 'RELEASE', params: [], releaseError: error?.message ?? null }); },
      };
    },
  };
}

test('Postgres admission store commits all admission records in one transaction', async () => {
  const pool = fakePool();
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.commitAdmission(input());
  assert.equal(result.ok, true);
  assert.equal(result.trustedIntroductions, 2);
  const sql = pool.calls.map(x => x.sql);
  assert.equal(sql[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.ok(sql.some(x => x.includes('FOR UPDATE')));
  assert.equal(sql.filter(x => x.startsWith('INSERT INTO peer_admissions')).length, 1);
  assert.equal(sql.filter(x => x.startsWith('INSERT INTO peer_admission_issuers')).length, 2);
  assert.equal(sql.filter(x => x.startsWith('INSERT INTO consumed_peer_invitations')).length, 2);
  assert.ok(sql.includes('COMMIT'));
  assert.ok(!sql.includes('ROLLBACK'));
});

test('unique invitation conflict rolls back and fails closed', async () => {
  const pool = fakePool({ failInvitationInsert: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.commitAdmission(input());
  assert.deepEqual(result, { ok: false, reason: 'invitation-already-used' });
  assert.ok(pool.calls.some(x => x.sql === 'ROLLBACK'));
  assert.ok(!pool.calls.some(x => x.sql === 'COMMIT'));
});

test('serialization failures retry the entire transaction', async () => {
  const pool = fakePool({ retryOnce: true });
  const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 2 });
  const result = await store.commitAdmission(input());
  assert.equal(result.ok, true);
  assert.equal(pool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 2);
  assert.equal(pool.calls.filter(x => x.sql === 'ROLLBACK').length, 1);
  assert.equal(pool.calls.filter(x => x.sql === 'COMMIT').length, 1);
});

test('invalid or duplicate issuer input is rejected before opening a connection', async () => {
  const pool = fakePool();
  const store = new PostgresPeerAdmissionStore({ pool });
  const malformed = input();
  malformed.issuerNodeIds = [id('1'), id('1')];
  assert.deepEqual(await store.commitAdmission(malformed), { ok: false, reason: 'invalid-input' });
  assert.equal(pool.calls.length, 0);
});

test('release is idempotent and updates reservation count only when active row changed', async () => {
  const pool = fakePool({ activeReservations: 1 });
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.releaseAdmission(id('a'), 'revoked');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.ok(pool.calls.some(x => x.sql.includes('active_reservations = active_reservations - 1')));
  assert.ok(pool.calls.some(x => x.sql === 'COMMIT'));
});


test('release fails closed and rolls back if an active admission has no capacity reservation', async () => {
  const pool = fakePool({ activeReservations: 0 });
  const store = new PostgresPeerAdmissionStore({ pool });
  await assert.rejects(
    store.releaseAdmission(id('a'), 'revoked'),
    { code: 'ZION_ADMISSION_STATE_INCONSISTENT' },
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
  assert.ok(!pool.calls.some(call => call.sql.includes('GREATEST(0, active_reservations - 1)')));
});

test('ambiguous commit blocks only the affected subject until authoritative reconciliation', async () => {
  const pool = fakePool({ failCommit: true });
  const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 3 });
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  assert.equal(pool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 1);
  assert.equal(pool.calls.find(x => x.sql === 'RELEASE')?.releaseError, 'connection lost during COMMIT',
    'a connection with an ambiguous COMMIT must be discarded, not returned to the pool');

  // An unrelated subject is not held hostage by the ambiguous outcome.
  assert.equal((await store.commitAdmission({ ...input(), subjectNodeId: id('b') })).ok, true);
  assert.equal(pool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 2);

  // The authoritative lookup resolves this subject's atomic transaction outcome.
  assert.equal(await store.isAdmitted(id('a')), false);
  assert.equal((await store.commitAdmission(input())).ok, true);
  assert.equal(pool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 3);
});



test('an in-flight stale admission read cannot clear a newer ambiguous-COMMIT marker', async () => {
  const basePool = fakePool({ failCommit: true });
  const originalConnect = basePool.connect.bind(basePool);
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  basePool.connect = async () => {
    const client = await originalConnect();
    return {
      ...client,
      async query(sql, params = []) {
        if (sql.includes("SELECT 1 AS admitted FROM peer_admissions")) {
          readStarted();
          await readGate;
        }
        return client.query(sql, params);
      },
    };
  };
  const store = new PostgresPeerAdmissionStore({ pool: basePool });
  const staleRead = store.isAdmitted(id('a'));
  await started;

  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  releaseRead();
  assert.equal(await staleRead, false);

  // The read started before the ambiguous COMMIT and therefore cannot reconcile it.
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  assert.equal(basePool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 1);

  // A fresh authoritative read may now reconcile the marker.
  assert.equal(await store.isAdmitted(id('a')), false);
  assert.equal((await store.commitAdmission(input())).ok, true);
});


test('startup preflight rejects a PostgreSQL standby before accepting official traffic', async () => {
  const pool = fakePool({ inRecovery: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  await assert.rejects(store.verifyPersistentState(), { code: 'ZION_ADMISSION_PRIMARY_REQUIRED' });
  assert.ok(!pool.calls.some(call => call.sql.startsWith('SELECT max_active_peers')),
    'policy state must not be treated as authoritative on a standby');
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});

test('ambiguous COMMIT marker is retained when reconciliation is routed to a standby', async () => {
  const pool = fakePool({ failCommit: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  pool.setInRecovery(true);
  await assert.rejects(store.isAdmitted(id('a')), { code: 'ZION_ADMISSION_PRIMARY_REQUIRED' });
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  pool.setInRecovery(false);
  assert.equal(await store.isAdmitted(id('a')), false);
  assert.equal((await store.commitAdmission(input())).ok, true);
});

test('authoritative admission lookup queries active PostgreSQL state', async () => {
  const pool = fakePool();
  const store = new PostgresPeerAdmissionStore({ pool });
  assert.equal(await store.isAdmitted(id('a')), false);
  assert.ok(pool.calls.some(call =>
    call.sql.includes("SELECT 1 AS admitted FROM peer_admissions WHERE subject_node_id = $1 AND status = 'active' LIMIT 1")));
  assert.equal(await store.isAdmitted('invalid'), false);
});


test('failed rollback discards the connection instead of returning uncertain transaction state to the pool', async () => {
  const pool = fakePool({ failInvitationInsert: true, failRollback: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.commitAdmission(input());
  assert.deepEqual(result, { ok: false, reason: 'invitation-already-used' });
  const release = pool.calls.find(call => call.sql === 'RELEASE');
  assert.equal(release?.releaseError, 'connection lost during ROLLBACK');
});


test('failed authoritative admission read discards the unhealthy connection', async () => {
  const pool = fakePool({ failAdmissionRead: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  await assert.rejects(store.isAdmitted(id('a')), /connection lost during admission read/);
  assert.equal(pool.calls.find(call => call.sql === 'RELEASE')?.releaseError, 'connection lost during admission read');
});

test('failed startup-preflight COMMIT discards its uncertain database session', async () => {
  const pool = fakePool({ failCommit: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  await assert.rejects(store.verifyPersistentState(), /commit outcome is unknown|connection lost during COMMIT/);
  assert.equal(pool.calls.find(call => call.sql === 'RELEASE')?.releaseError, 'connection lost during COMMIT');
});

test('ambiguous-COMMIT reconciliation locks capacity before reading subject state', async () => {
  const pool = fakePool({ failCommit: true });
  const store = new PostgresPeerAdmissionStore({ pool });
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  const beforeRead = pool.calls.length;
  assert.equal(await store.isAdmitted(id('a')), false);
  const reconciliation = pool.calls.slice(beforeRead).map(call => call.sql);
  assert.equal(reconciliation[0], 'BEGIN');
  assert.ok(reconciliation.indexOf('SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true FOR UPDATE') <
    reconciliation.findIndex(sql => sql.includes('SELECT 1 AS admitted FROM peer_admissions')),
    'reconciliation must wait on the admission transaction lock before reading the subject');
  assert.equal(reconciliation.at(-1), 'COMMIT');
  assert.equal((await store.commitAdmission(input())).ok, true);
});
