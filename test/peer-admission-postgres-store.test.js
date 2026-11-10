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

function fakePool({ failInvitationInsert = false, retryOnce = false, failCommit = false, admissionStatus = 'active' } = {}) {
  const calls = [];
  let retryPending = retryOnce;
  let commitPending = failCommit;
  let currentAdmissionStatus = admissionStatus;
  return {
    calls,
    async query(sql, params = []) {
      const client = await this.connect();
      try { return await client.query(sql, params); } finally { client.release(); }
    },
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
          if (sql.startsWith('SELECT status FROM peer_admissions')) return { rows: currentAdmissionStatus ? [{ status: currentAdmissionStatus }] : [] };
          if (sql.includes(`SET status = 'revoked'`)) { currentAdmissionStatus = 'revoked'; return { rows: [] }; }
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
            currentAdmissionStatus = params[1];
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



test('authoritative admission status distinguishes active, revoked, and missing identities', async () => {
  const activePool = fakePool({ admissionStatus: 'active' });
  const active = await new PostgresPeerAdmissionStore({ pool: activePool }).getAdmissionStatus(id('a'));
  assert.deepEqual(active, { ok: true, subjectNodeId: id('a'), status: 'active' });

  const missingPool = fakePool({ admissionStatus: null });
  const missing = await new PostgresPeerAdmissionStore({ pool: missingPool }).getAdmissionStatus(id('b'));
  assert.deepEqual(missing, { ok: true, subjectNodeId: id('b'), status: null });

  const unavailablePool = { async query() { throw new Error('database unavailable'); }, async connect() { throw new Error('database unavailable'); } };
  assert.deepEqual(await new PostgresPeerAdmissionStore({ pool: unavailablePool }).getAdmissionStatus(id('c')), {
    ok: false, reason: 'admission-state-unavailable',
  });
});

test('revocation commits once, is idempotent, and never reactivates released admissions', async () => {
  const pool = fakePool({ admissionStatus: 'active' });
  const store = new PostgresPeerAdmissionStore({ pool });
  assert.deepEqual(await store.revokeAdmission(id('a')), {
    ok: true, changed: true, subjectNodeId: id('a'), status: 'revoked',
  });
  assert.deepEqual(await store.revokeAdmission(id('a')), {
    ok: true, changed: false, subjectNodeId: id('a'), status: 'revoked',
  });
  assert.equal(pool.calls.filter(x => x.sql.includes("SET status = 'revoked'")).length, 1);
  assert.equal(pool.calls.filter(x => x.sql.includes('GREATEST(0, active_reservations - 1)')).length, 1);
  assert.equal(pool.calls.filter(x => x.sql.includes("pg_notify('zion_peer_revocations'")).length, 1,
    'only the active-to-revoked transition publishes a notification');

  const released = new PostgresPeerAdmissionStore({ pool: fakePool({ admissionStatus: 'released' }) });
  assert.deepEqual(await released.revokeAdmission(id('b')), {
    ok: false, reason: 'admission-already-released', subjectNodeId: id('b'), status: 'released',
  });
});

test('ambiguous commit outcome fails closed and is never automatically retried', async () => {
  const pool = fakePool({ failCommit: true });
  const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 3 });
  assert.deepEqual(await store.commitAdmission(input()), {
    ok: false, reason: 'admission-state-unavailable',
  });
  const beginsAfterFirst = pool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length;
  assert.equal(beginsAfterFirst, 1);
  assert.deepEqual(await store.commitAdmission({ ...input(), subjectNodeId: id('b') }), {
    ok: false, reason: 'admission-state-unavailable',
  });
  assert.equal(pool.calls.filter(x => x.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length, 1);
});


test('shared admission fence holds the advisory lock through dispatch and rejects revoked peers', async () => {
  const pool = fakePool({ admissionStatus: 'active' });
  const store = new PostgresPeerAdmissionStore({ pool });
  let dispatched = 0;
  const allowed = await store.withAdmissionFence(id('a'), async () => { dispatched++; return 'handled'; });
  assert.deepEqual(allowed, {
    ok: true, admitted: true, status: 'active', value: 'handled',
  });
  assert.equal(dispatched, 1);
  const sql = pool.calls.map(x => x.sql);
  assert.ok(sql.includes('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))'));
  assert.ok(sql.indexOf('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))') <
    sql.findIndex(x => x.startsWith('SELECT status FROM peer_admissions')));
  assert.ok(sql.includes('COMMIT'));

  const revokedPool = fakePool({ admissionStatus: 'revoked' });
  const revokedStore = new PostgresPeerAdmissionStore({ pool: revokedPool });
  const denied = await revokedStore.withAdmissionFence(id('b'), async () => { dispatched++; });
  assert.deepEqual(denied, { ok: true, admitted: false, status: 'revoked' });
  assert.equal(dispatched, 1);
});

test('revocation acquires the exclusive advisory fence before changing durable admission state', async () => {
  const pool = fakePool({ admissionStatus: 'active' });
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.revokeAdmission(id('a'));
  assert.equal(result.ok, true);
  const sql = pool.calls.map(x => x.sql);
  const exclusive = sql.indexOf('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  const statusRead = sql.findIndex(x => x.startsWith('SELECT status FROM peer_admissions'));
  const statusWrite = sql.findIndex(x => x.includes("SET status = 'revoked'"));
  assert.ok(exclusive >= 0 && exclusive < statusRead && statusRead < statusWrite);
});




test('release reports missing and already-inactive admission states without changing capacity', async () => {
  const missingPool = fakePool({ admissionStatus: null });
  const missing = await new PostgresPeerAdmissionStore({ pool: missingPool }).releaseAdmission(id('a'));
  assert.deepEqual(missing, {
    ok: false, reason: 'admission-not-found', subjectNodeId: id('a'),
  });
  assert.equal(missingPool.calls.some(x => x.sql.startsWith('UPDATE peer_admissions')), false);

  const revokedPool = fakePool({ admissionStatus: 'revoked' });
  const revoked = await new PostgresPeerAdmissionStore({ pool: revokedPool }).releaseAdmission(id('a'));
  assert.deepEqual(revoked, {
    ok: false, changed: false, reason: 'admission-already-inactive',
    subjectNodeId: id('a'), status: 'revoked',
  });
  assert.equal(revokedPool.calls.some(x => x.sql.startsWith('UPDATE peer_admissions')), false);

  const releasedPool = fakePool({ admissionStatus: 'released' });
  const released = await new PostgresPeerAdmissionStore({ pool: releasedPool }).releaseAdmission(id('a'));
  assert.deepEqual(released, {
    ok: true, changed: false, subjectNodeId: id('a'), status: 'released',
  });
  assert.equal(releasedPool.calls.some(x => x.sql.startsWith('UPDATE peer_admissions')), false);
});

test('release serializes against dispatch and notifies peers when admission becomes inactive', async () => {
  const pool = fakePool({ admissionStatus: 'active' });
  const store = new PostgresPeerAdmissionStore({ pool });
  const result = await store.releaseAdmission(id('a'), 'released');
  assert.deepEqual(result, {
    ok: true, changed: true, subjectNodeId: id('a'), status: 'released',
  });
  const sql = pool.calls.map(x => x.sql);
  const exclusive = sql.indexOf('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
  const statusWrite = sql.findIndex(x => x.includes("SET status = $2"));
  const notification = sql.findIndex(x => x.includes("pg_notify('zion_peer_revocations'"));
  assert.ok(exclusive >= 0 && exclusive < statusWrite,
    'release must acquire the exclusive dispatch fence before changing status');
  assert.ok(notification > statusWrite,
    'release must notify listeners after the durable status transition is staged');
  assert.ok(sql.includes('COMMIT'));
});
