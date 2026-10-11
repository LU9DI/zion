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

test('real PostgreSQL serializes independent-process capacity, nonce replay, subject, and release operations', {
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

    // A fresh CI database is expected; fail rather than silently reuse contaminated state.
    const { rows: before } = await pool.query(
      'SELECT (SELECT count(*) FROM peer_admissions)::integer AS admissions, active_reservations FROM peer_admission_capacity WHERE singleton = true',
    );
    assert.equal(before[0].admissions, 0);
    assert.equal(Number(before[0].active_reservations), 0);

    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 1, max_admissions_per_issuer = 5, min_storage_headroom_ratio = 0.1, policy_version = policy_version + 1 WHERE singleton = true',
    );

    // Different Node processes and pools ensure process-local queues cannot mask races.
    const capacityRace = await Promise.all([
      runAdmissionWorker(admissionInput('a', ['1', '2'], ['a', 'b'])),
      runAdmissionWorker(admissionInput('b', ['3', '4'], ['c', 'd'])),
    ]);
    assert.equal(capacityRace.filter(result => result.ok).length, 1,
      'serializable transactions must not overbook a one-peer capacity');
    assert.equal(capacityRace.filter(result => !result.ok && result.reason === 'peer-capacity-reached').length, 1);

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

    let state = await pool.query(
      "SELECT c.active_reservations, count(a.subject_node_id)::integer AS active_admissions FROM peer_admission_capacity c LEFT JOIN peer_admissions a ON a.status = 'active' WHERE c.singleton = true GROUP BY c.active_reservations",
    );
    assert.equal(Number(state.rows[0].active_reservations), 0);
    assert.equal(state.rows[0].active_admissions, 0);

    await pool.query(
      'UPDATE peer_admission_policy SET max_active_peers = 10, policy_version = policy_version + 1 WHERE singleton = true',
    );

    // Two processes attempt to consume the same issuer+nonce, while their other
    // vouchers differ. Exactly one transaction may commit that nonce.
    const nonceRace = await Promise.all([
      runAdmissionWorker(admissionInput('c', ['1', '5'], ['e', 'f'])),
      runAdmissionWorker(admissionInput('d', ['1', '6'], ['e', 'g'])),
    ]);
    assert.equal(nonceRace.filter(result => result.ok).length, 1,
      'the unique consumed-invitation key must prevent concurrent replay');
    assert.equal(nonceRace.filter(result => !result.ok && result.reason === 'invitation-already-used').length, 1);

    const { rows: nonceWinnerRows } = await pool.query(
      "SELECT subject_node_id FROM peer_admissions WHERE status = 'active'",
    );
    assert.equal(nonceWinnerRows.length, 1);
    const nonceWinner = nonceWinnerRows[0].subject_node_id.trim();
    const nonceRelease = await store.releaseAdmission(nonceWinner, 'released');
    assert.equal(nonceRelease.ok, true);
    assert.equal(nonceRelease.changed, true);

    // Two processes race the same subject but use different invitation keys.
    const subjectRace = await Promise.all([
      runAdmissionWorker(admissionInput('e', ['7', '8'], ['h', 'i'])),
      runAdmissionWorker(admissionInput('e', ['9', 'a'], ['j', 'k'])),
    ]);
    assert.equal(subjectRace.filter(result => result.ok).length, 1,
      'subject primary key must prevent duplicate concurrent admission');
    assert.equal(subjectRace.filter(result => !result.ok && result.reason === 'subject-already-admitted').length, 1);

    state = await pool.query(
      "SELECT c.active_reservations, count(a.subject_node_id)::integer AS active_admissions FROM peer_admission_capacity c LEFT JOIN peer_admissions a ON a.status = 'active' WHERE c.singleton = true GROUP BY c.active_reservations",
    );
    assert.equal(Number(state.rows[0].active_reservations), 1);
    assert.equal(state.rows[0].active_admissions, 1);
  } finally {
    await pool.end();
  }
});
