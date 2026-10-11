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

function fakePool({ failInvitationInsert = false, retryOnce = false, failCommit = false } = {}) {
  const calls = [];
  let retryPending = retryOnce;
  let commitPending = failCommit;
  return {
    calls,
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
          if (sql === 'COMMIT' && commitPending) {
            commitPending = false;
            throw Object.assign(new Error('connection lost during COMMIT'), { code: '08006' });
          }
          if (sql.startsWith('SELECT max_active_peers')) {
            return { rows: [{ max_active_peers: 100, max_admissions_per_issuer: 5,
              min_storage_headroom_ratio: 0.1, policy_version: 7 }] };
          }
          if (sql.startsWith('SELECT active_reservations')) return { rows: [{ active_reservations: 0 }] };
          if (sql.includes('count(*)::integer')) return { rows: [{ count: 0 }] };
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
        release() { calls.push({ sql: 'RELEASE', params: [] }); },
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
  const pool = fakePool();
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.releaseAdmission(id('a'), 'revoked');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.ok(pool.calls.some(x => x.sql.includes('GREATEST(0, active_reservations - 1)')));
  assert.ok(pool.calls.some(x => x.sql === 'COMMIT'));
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

test('authoritative admission lookup queries active PostgreSQL state', async () => {
  const pool = fakePool();
  const store = new PostgresPeerAdmissionStore({ pool });
  assert.equal(await store.isAdmitted(id('a')), false);
  assert.ok(pool.calls.some(call =>
    call.sql.includes("SELECT 1 AS admitted FROM peer_admissions WHERE subject_node_id = $1 AND status = 'active' LIMIT 1")));
  assert.equal(await store.isAdmitted('invalid'), false);
});
