import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PostgresPeerAdmissionStore } from '../src/peer-admission-postgres-store.js';

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
      new URL('./fixtures/postgres-admission-worker.js', import.meta.url).pathname,
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
    const migration = await readFile(
      new URL('../migrations/postgres/0001_peer_admission.sql', import.meta.url),
      'utf8',
    );
    await pool.query(migration);

    const { rows: before } = await pool.query(
      'SELECT (SELECT count(*) FROM peer_admissions)::integer AS admissions, active_reservations FROM peer_admission_capacity WHERE singleton = true',
    );
    assert.equal(before[0].admissions, 0);
    assert.equal(Number(before[0].active_reservations), 0);

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
    const { rows: capacity } = await pool.query(
      'SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true',
    );
    assert.equal(Number(capacity[0].active_reservations), 1);

    const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 5 });
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

    // Scenario 1b: revocation is durable, idempotent, and decrements capacity once.
    await clearAdmissions(pool);
    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 10, max_admissions_per_issuer = 5, policy_version = policy_version + 1 WHERE singleton = true',
    );
    const revocationStore = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 5 });
    const admitted = await revocationStore.commitAdmission(
      admissionInput('9', ['1', '2'], ['9', 'a']),
    );
    assert.equal(admitted.ok, true);
    assert.deepEqual(await revocationStore.getAdmissionStatus(id('9')), {
      ok: true, subjectNodeId: id('9'), status: 'active',
    });

    // A dedicated session must observe the notification only after the durable
    // status transition commits; the listener is independent of pooled query sessions.
    const notificationClient = await pool.connect();
    try {
      await notificationClient.query('LISTEN zion_peer_revocations');
      const notification = new Promise(resolve => notificationClient.once('notification', resolve));
      const revoked = await revocationStore.revokeAdmission(id('9'));
      assert.deepEqual(
        { ok: revoked.ok, changed: revoked.changed, status: revoked.status },
        { ok: true, changed: true, status: 'revoked' },
      );
      let timeout;
      const event = await Promise.race([
        notification,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('revocation notification timed out')), 2000);
        }),
      ]).finally(() => clearTimeout(timeout));
      assert.equal(event.channel, 'zion_peer_revocations');
      assert.equal(event.payload, id('9'));
    } finally {
      try { await notificationClient.query('UNLISTEN zion_peer_revocations'); } finally { notificationClient.release(); }
    }
    const repeatedRevocation = await revocationStore.revokeAdmission(id('9'));
    assert.deepEqual(
      { ok: repeatedRevocation.ok, changed: repeatedRevocation.changed, status: repeatedRevocation.status },
      { ok: true, changed: false, status: 'revoked' },
    );
    assert.deepEqual(await revocationStore.getAdmissionStatus(id('9')), {
      ok: true, subjectNodeId: id('9'), status: 'revoked',
    });
    const { rows: revokedCapacity } = await pool.query(
      "SELECT c.active_reservations, count(a.subject_node_id)::integer AS active_admissions FROM peer_admission_capacity c LEFT JOIN peer_admissions a ON a.status = 'active' WHERE c.singleton = true GROUP BY c.active_reservations",
    );
    assert.equal(Number(revokedCapacity[0].active_reservations), 0);
    assert.equal(revokedCapacity[0].active_admissions, 0);

    const cannotReadmitRevoked = await revocationStore.commitAdmission(
      admissionInput('9', ['1', '2'], ['b', 'c']),
    );
    assert.deepEqual(cannotReadmitRevoked, {
      ok: false, reason: 'subject-already-admitted',
    });

    // Scenario 1c: an in-flight authorized dispatch holds a shared advisory
    // fence. Revocation must wait for it, then future dispatches must see revoked.
    const fencedAdmission = await revocationStore.commitAdmission(
      admissionInput('8', ['3', '4'], ['e', 'f']),
    );
    assert.equal(fencedAdmission.ok, true);
    let releaseDispatch;
    let markDispatchStarted;
    const dispatchStarted = new Promise(resolve => { markDispatchStarted = resolve; });
    const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
    const inFlightDispatch = revocationStore.withAdmissionFence(id('8'), async () => {
      markDispatchStarted();
      await dispatchGate;
      return 'frame-dispatched';
    });
    await dispatchStarted;
    let revocationFinished = false;
    const waitingRevocation = revocationStore.revokeAdmission(id('8')).then(result => {
      revocationFinished = true;
      return result;
    });
    let revocationWaitingOnAdvisoryLock = false;
    const waitDeadline = Date.now() + 2000;
    while (!revocationWaitingOnAdvisoryLock && Date.now() < waitDeadline) {
      const { rows: waiters } = await pool.query(
        "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%'",
      );
      revocationWaitingOnAdvisoryLock = Number(waiters[0]?.count ?? 0) > 0;
      if (!revocationWaitingOnAdvisoryLock) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const revocationWaitedForDispatch = revocationWaitingOnAdvisoryLock && !revocationFinished;
    releaseDispatch();
    assert.deepEqual(await inFlightDispatch, {
      ok: true, admitted: true, status: 'active', value: 'frame-dispatched',
    });
    assert.equal(revocationWaitedForDispatch, true,
      'revocation cannot commit while an authorized application dispatch is in flight');
    assert.equal((await waitingRevocation).status, 'revoked');
    const postRevocationDispatch = await revocationStore.withAdmissionFence(id('8'), async () => {
      throw new Error('revoked peer must not dispatch');
    });
    assert.deepEqual(postRevocationDispatch, {
      ok: true, admitted: false, status: 'revoked',
    });

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
  } finally {
    await pool.end();
  }
});
