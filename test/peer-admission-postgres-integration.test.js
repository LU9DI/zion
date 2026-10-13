import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PostgresPeerAdmissionStore } from '../src/peer-admission-postgres-store.js';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';
import { VerifiedPostgresPeerAdmissionService } from '../src/verified-postgres-peer-admission-service.js';
import { runPostgresMigrations } from '../scripts/migrate-postgres.js';

const enabled = Boolean(process.env.ZION_POSTGRES_TEST_URL);
const id = digit => digit.repeat(64);
const nonce = digit => digit.repeat(32);

function admissionInput(subjectDigit, issuerDigits, nonceDigits) {
  return {
    subjectNodeId: id(subjectDigit),
    issuerNodeIds: issuerDigits.map(id),
    invitations: issuerDigits.map((issuerDigit, index) => ({
      issuerNodeId: id(issuerDigit),
      nonce: nonce(nonceDigits[index]),
    })),
    storageHeadroomRatio: 0.5,
    maxActivePeers: 10,
    maxAdmissionsPerIssuer: 5,
  };
}

function runAdmissionWorker(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      new URL('../scripts/test-fixtures/postgres-admission-worker.mjs', import.meta.url).pathname,
    ], {
      env: { ...process.env, ZION_ADMISSION_INPUT_JSON: JSON.stringify(input) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(`Admission worker exited ${code}: ${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(new Error(`Invalid worker result: ${stdout}; ${error}`)); }
    });
  });
}

async function clearAdmissions(pool) {
  await pool.query('DELETE FROM consumed_peer_invitations');
  await pool.query('DELETE FROM peer_admission_issuers');
  await pool.query('DELETE FROM peer_admissions');
  await pool.query(
    'UPDATE peer_admission_capacity SET active_reservations = 0 WHERE singleton = true',
  );
}

async function race(pool, first, second) {
  const results = await Promise.all([runAdmissionWorker(first), runAdmissionWorker(second)]);
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  return results;
}

test('PostgreSQL migration and independent-process admission races enforce capacity, nonce, subject, and issuer quota', {
  skip: !enabled && 'set ZION_POSTGRES_TEST_URL to run real PostgreSQL integration tests',
}, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.ZION_POSTGRES_TEST_URL,
    max: 8,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
  });

  try {
    const migrationResult = await runPostgresMigrations({ pool });
    assert.equal(migrationResult.ok, true);
    assert.equal(migrationResult.migrations.length, 1);
    assert.equal(migrationResult.migrations[0].id, '0001_peer_admission');
    assert.ok(
      ['applied', 'already-applied'].includes(migrationResult.migrations[0].status),
      `unexpected migration status: ${migrationResult.migrations[0].status}`,
    );

    const { rows: before } = await pool.query(
      'SELECT (SELECT count(*) FROM peer_admissions)::integer AS admissions, active_reservations FROM peer_admission_capacity WHERE singleton = true',
    );
    assert.equal(before[0].admissions, 0);
    assert.equal(Number(before[0].active_reservations), 0);
    const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 5 });
    assert.deepEqual(await store.verifyPersistentState(), {
      ok: true, activeAdmissions: 0, activeReservations: 0, policyVersion: 1,
    });

    // An ambiguous-COMMIT reconciliation must wait for the shared capacity lock.
    // Otherwise a read could observe absence before an in-flight COMMIT settles,
    // clear the fail-closed marker, and then miss a transaction that commits later.
    const reconciliationLock = await pool.connect();
    let lockOpen = false;
    let reconciliation;
    let reconciliationFinished = false;
    try {
      await reconciliationLock.query('BEGIN');
      lockOpen = true;
      await reconciliationLock.query(
        'SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true FOR UPDATE',
      );
      store.unknownCommitSubjects.set(id('f'), {});
      reconciliation = store.isAdmitted(id('f')).then(value => {
        reconciliationFinished = true;
        return value;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(reconciliationFinished, false,
        'reconciliation must wait for the transaction holding the capacity row');
      await reconciliationLock.query('COMMIT');
      lockOpen = false;
    } finally {
      if (lockOpen) await reconciliationLock.query('ROLLBACK').catch(() => {});
      reconciliationLock.release();
    }
    assert.equal(await reconciliation, false);
    assert.equal(store.unknownCommitSubjects.has(id('f')), false,
      'the marker clears only after the serialized authoritative read completes');
    await pool.query(
      'UPDATE peer_admission_capacity SET active_reservations = 1 WHERE singleton = true',
    );
    await assert.rejects(store.verifyPersistentState(), { code: 'ZION_ADMISSION_STATE_INCONSISTENT' });
    await pool.query(
      'UPDATE peer_admission_capacity SET active_reservations = 0 WHERE singleton = true',
    );
    // A counter can match while active rows still lack their required issuer
    // and consumed-invitation evidence; startup must reject that state as well.
    await pool.query(
      "INSERT INTO peer_admissions (subject_node_id, status, policy_version) VALUES ($1, 'active', 1)",
      [id('f')],
    );
    await pool.query(
      'UPDATE peer_admission_capacity SET active_reservations = 1 WHERE singleton = true',
    );
    await assert.rejects(store.verifyPersistentState(), { code: 'ZION_ADMISSION_STATE_INCONSISTENT' });
    await pool.query('DELETE FROM peer_admissions WHERE subject_node_id = $1', [id('f')]);
    await pool.query(
      'UPDATE peer_admission_capacity SET active_reservations = 0 WHERE singleton = true',
    );

    // A valid issuer/evidence pair must not hide an extra consumed invitation
    // from an issuer that is absent from the active admission's issuer set.
    await pool.query(
      "INSERT INTO peer_admissions (subject_node_id, status, policy_version) VALUES ($1, 'active', 1)",
      [id('f')],
    );
    await pool.query(
      'INSERT INTO peer_admission_issuers (subject_node_id, issuer_node_id) VALUES ($1, $2)',
      [id('f'), id('1')],
    );
    await pool.query(
      'INSERT INTO consumed_peer_invitations (issuer_node_id, nonce, subject_node_id) VALUES ($1, $2, $3), ($4, $5, $3)',
      [id('1'), nonce('a'), id('f'), id('2'), nonce('b')],
    );
    await pool.query(
      'UPDATE peer_admission_capacity SET active_reservations = 1 WHERE singleton = true',
    );
    await assert.rejects(store.verifyPersistentState(), { code: 'ZION_ADMISSION_STATE_INCONSISTENT' });
    await pool.query('DELETE FROM consumed_peer_invitations WHERE subject_node_id = $1', [id('f')]);
    await pool.query('DELETE FROM peer_admissions WHERE subject_node_id = $1', [id('f')]);
    await pool.query(
      'UPDATE peer_admission_capacity SET active_reservations = 0 WHERE singleton = true',
    );

    // Scenario 1: two independent processes compete for the only available slot.
    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 1, max_admissions_per_issuer = 5, min_storage_headroom_ratio = 0.1, policy_version = policy_version + 1 WHERE singleton = true',
    );
    let results = await race(
      pool,
      admissionInput('a', ['1', '2'], ['a', 'b']),
      admissionInput('b', ['3', '4'], ['c', 'd']),
    );
    assert.equal(results.filter(result => result.reason === 'peer-capacity-reached').length, 1);
    const { rows: active } = await pool.query(
      "SELECT subject_node_id FROM peer_admissions WHERE status = 'active'",
    );
    assert.equal(active.length, 1);
    const winner = active[0].subject_node_id.trim();
    assert.equal(await store.isAdmitted(winner), true);
    const { rows: capacity } = await pool.query(
      'SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true',
    );
    assert.equal(Number(capacity[0].active_reservations), 1);

    const released = await store.releaseAdmission(winner, 'released');
    assert.deepEqual(
      { ok: released.ok, changed: released.changed, status: released.status },
      { ok: true, changed: true, status: 'released' },
    );
    const { rows: after } = await pool.query(
      "SELECT c.active_reservations, count(a.subject_node_id)::integer AS active_admissions FROM peer_admission_capacity c LEFT JOIN peer_admissions a ON a.status = 'active' WHERE c.singleton = true GROUP BY c.active_reservations",
    );
    assert.equal(Number(after[0].active_reservations), 0);
    assert.equal(after[0].active_admissions, 0);
    assert.equal(await store.isAdmitted(winner), false);

    // Scenario 2: the same invitation nonces cannot be consumed by two subjects.
    await clearAdmissions(pool);
    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 10, max_admissions_per_issuer = 5, policy_version = policy_version + 1 WHERE singleton = true',
    );
    results = await race(
      pool,
      admissionInput('c', ['1', '2'], ['e', 'f']),
      admissionInput('d', ['1', '2'], ['e', 'f']),
    );
    assert.equal(results.filter(result => result.reason === 'invitation-already-used').length, 1, JSON.stringify(results));
    const { rows: consumed } = await pool.query('SELECT count(*)::integer AS count FROM consumed_peer_invitations');
    assert.equal(consumed[0].count, 2);

    // Scenario 3: one subject cannot be admitted twice by concurrent processes.
    await clearAdmissions(pool);
    results = await race(
      pool,
      admissionInput('e', ['1', '2'], ['1', '2']),
      admissionInput('e', ['1', '2'], ['3', '4']),
    );
    assert.equal(results.filter(result => result.reason === 'subject-already-admitted').length, 1, JSON.stringify(results));
    const { rows: subjectCount } = await pool.query(
      'SELECT count(*)::integer AS count FROM peer_admissions WHERE subject_node_id = $1',
      [id('e')],
    );
    assert.equal(subjectCount[0].count, 1);

    // Scenario 4: independent admissions cannot jointly exceed an issuer quota of one.
    await clearAdmissions(pool);
    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 10, max_admissions_per_issuer = 1, policy_version = policy_version + 1 WHERE singleton = true',
    );
    results = await race(
      pool,
      admissionInput('f', ['1', '2'], ['5', '6']),
      admissionInput('0', ['1', '3'], ['7', '8']),
    );
    assert.equal(results.filter(result => result.reason === 'issuer-admission-quota-reached').length, 1, JSON.stringify(results));
    const { rows: quotaCount } = await pool.query(
      'SELECT count(*)::integer AS count FROM peer_admission_issuers WHERE issuer_node_id = $1',
      [id('1')],
    );
    assert.equal(quotaCount[0].count, 1);

    // Scenario 5: real voucher verification feeds the transactional PostgreSQL store.
    await clearAdmissions(pool);
    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 10, max_admissions_per_issuer = 5, min_storage_headroom_ratio = 0.1, policy_version = policy_version + 1 WHERE singleton = true',
    );
    const issuerIdentities = [createNodeIdentity(), createNodeIdentity()];
    const subjectIdentity = createNodeIdentity();
    const vouchers = issuerIdentities.map(issuerIdentity =>
      createPeerIntroductionVoucher({ issuerIdentity, subjectNodeId: subjectIdentity.nodeId }));
    const service = new VerifiedPostgresPeerAdmissionService({
      store: new PostgresPeerAdmissionStore({ pool }),
      trustedIssuerNodeIds: issuerIdentities.map(identity => identity.nodeId),
      threshold: 2,
      storageHeadroomProvider: async () => 0.5,
    });
    assert.equal((await service.admit({ subjectNodeId: subjectIdentity.nodeId, vouchers })).ok, true);
    assert.equal(await service.isAdmitted(subjectIdentity.nodeId), true);
    assert.equal((await service.releaseAdmission(subjectIdentity.nodeId)).changed, true);
    assert.equal(await service.isAdmitted(subjectIdentity.nodeId), false);
  } finally {
    await pool.end();
  }
});
