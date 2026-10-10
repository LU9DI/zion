import test from 'node:test';
import assert from 'node:assert/strict';
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

test('real PostgreSQL migration, concurrent capacity enforcement, and release lifecycle', {
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

    const store = new PostgresPeerAdmissionStore({ pool, maxTransactionRetries: 5 });
    const attempts = await Promise.all([
      store.commitAdmission(admissionInput('a', ['1', '2'], ['a', 'b'])),
      store.commitAdmission(admissionInput('b', ['3', '4'], ['c', 'd'])),
    ]);

    assert.equal(attempts.filter(result => result.ok).length, 1,
      'serializable transactions must not overbook a one-peer capacity');
    assert.equal(attempts.filter(result => !result.ok && result.reason === 'peer-capacity-reached').length, 1);

    const { rows: active } = await pool.query(
      "SELECT subject_node_id FROM peer_admissions WHERE status = 'active'",
    );
    assert.equal(active.length, 1);
    const winner = active[0].subject_node_id.trim();

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
  } finally {
    await pool.end();
  }
});
