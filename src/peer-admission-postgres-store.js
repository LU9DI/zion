const NODE_ID = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const RETRYABLE = new Set(['40001', '40P01']);

function validateInput(input) {
  return Boolean(input &&
    NODE_ID.test(input.subjectNodeId ?? '') &&
    Array.isArray(input.issuerNodeIds) && input.issuerNodeIds.length > 0 &&
    input.issuerNodeIds.every(id => NODE_ID.test(id)) &&
    new Set(input.issuerNodeIds).size === input.issuerNodeIds.length &&
    Array.isArray(input.invitations) &&
    input.invitations.length === input.issuerNodeIds.length &&
    input.invitations.every(x => x && NODE_ID.test(x.issuerNodeId ?? '') &&
      NONCE.test(x.nonce ?? '')) &&
    new Set(input.invitations.map(x => x.issuerNodeId)).size === input.invitations.length &&
    input.invitations.every(x => input.issuerNodeIds.includes(x.issuerNodeId)) &&
    Number.isFinite(input.storageHeadroomRatio) &&
    input.storageHeadroomRatio >= 0 && input.storageHeadroomRatio <= 1 &&
    Number.isSafeInteger(input.maxActivePeers) && input.maxActivePeers > 0 &&
    Number.isSafeInteger(input.maxAdmissionsPerIssuer) && input.maxAdmissionsPerIssuer > 0);
}

/**
 * Transactional PostgreSQL persistence for peer admission.
 *
 * Inject a node-postgres-compatible pool. Voucher cryptographic verification and
 * trusted-issuer policy remain the caller's responsibility; this store atomically
 * enforces uniqueness, issuer quotas, storage-headroom threshold, and capacity.
 * It is not a DHT consensus mechanism. The schema migration must be applied first.
 */
export class PostgresPeerAdmissionStore {
  constructor({ pool, maxTransactionRetries = 3 } = {}) {
    if (!pool || typeof pool.connect !== 'function' ||
      !Number.isSafeInteger(maxTransactionRetries) ||
      maxTransactionRetries < 0 || maxTransactionRetries > 10) {
      throw new TypeError('Invalid PostgreSQL peer-admission store configuration');
    }
    this.pool = pool;
    this.maxTransactionRetries = maxTransactionRetries;
    this.unknownCommitSubjects = new Map();
  }

  async #transaction(work, subjectNodeId) {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let began = false;
      let commitStarted = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        began = true;
        const result = await work(client);
        commitStarted = true;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        if (commitStarted) {
          // COMMIT may have reached PostgreSQL even when the connection failed.
          // Never replay this transaction automatically; reconcile from authoritative state.
          if (typeof subjectNodeId === 'string' && NODE_ID.test(subjectNodeId)) {
            // A unique marker prevents an older in-flight read from clearing a newer
            // ambiguous outcome for the same subject.
            this.unknownCommitSubjects.set(subjectNodeId, {});
          }
          throw Object.assign(new Error('PostgreSQL commit outcome is unknown; reconcile authoritative state before retrying'), {
            code: 'ZION_ADMISSION_COMMIT_OUTCOME_UNKNOWN', cause: error,
          });
        }
        if (began) {
          try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        }
        if (RETRYABLE.has(error?.code) && attempt < this.maxTransactionRetries) continue;
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async commitAdmission(input) {
    if (this.unknownCommitSubjects.has(input?.subjectNodeId)) return { ok: false, reason: 'admission-state-unavailable' };
    if (!validateInput(input)) return { ok: false, reason: 'invalid-input' };
    try {
      return await this.#transaction(async client => {
        const policyResult = await client.query(
          'SELECT max_active_peers, max_admissions_per_issuer, min_storage_headroom_ratio, policy_version FROM peer_admission_policy WHERE singleton = true FOR UPDATE',
        );
        const capacityResult = await client.query(
          'SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true FOR UPDATE',
        );
        const policy = policyResult.rows?.[0];
        const capacity = capacityResult.rows?.[0];
        if (!policy || !capacity) throw Object.assign(new Error('Admission policy/capacity row missing'), { code: 'ZION_ADMISSION_CONFIG_MISSING' });

        if (input.storageHeadroomRatio < Number(policy.min_storage_headroom_ratio)) {
          return { ok: false, reason: 'storage-headroom-too-low' };
        }
        const activeLimit = Math.min(Number(policy.max_active_peers), input.maxActivePeers);
        if (Number(capacity.active_reservations) >= activeLimit) {
          return { ok: false, reason: 'peer-capacity-reached' };
        }

        const quota = Math.min(Number(policy.max_admissions_per_issuer), input.maxAdmissionsPerIssuer);
        for (const issuerNodeId of input.issuerNodeIds) {
          const countResult = await client.query(
            `SELECT count(*)::integer AS count
             FROM peer_admission_issuers i
             JOIN peer_admissions a ON a.subject_node_id = i.subject_node_id
             WHERE i.issuer_node_id = $1 AND a.status = 'active'`,
            [issuerNodeId],
          );
          if (Number(countResult.rows?.[0]?.count ?? 0) >= quota) {
            return { ok: false, reason: 'issuer-admission-quota-reached' };
          }
        }

        await client.query(
          'INSERT INTO peer_admissions (subject_node_id, status, policy_version) VALUES ($1, $2, $3)',
          [input.subjectNodeId, 'active', Number(policy.policy_version)],
        );
        for (const issuerNodeId of input.issuerNodeIds) {
          await client.query(
            'INSERT INTO peer_admission_issuers (subject_node_id, issuer_node_id) VALUES ($1, $2)',
            [input.subjectNodeId, issuerNodeId],
          );
        }
        for (const invitation of input.invitations) {
          await client.query(
            'INSERT INTO consumed_peer_invitations (issuer_node_id, nonce, subject_node_id) VALUES ($1, $2, $3)',
            [invitation.issuerNodeId, invitation.nonce, input.subjectNodeId],
          );
        }
        await client.query(
          'UPDATE peer_admission_capacity SET active_reservations = active_reservations + 1, updated_at = now() WHERE singleton = true',
        );
        return {
          ok: true,
          subjectNodeId: input.subjectNodeId,
          trustedIntroductions: input.issuerNodeIds.length,
          issuerNodeIds: [...input.issuerNodeIds],
        };
      }, input.subjectNodeId);
    } catch (error) {
      if (error?.code === '23505') {
        if (error.constraint === 'peer_admissions_pkey') {
          return { ok: false, reason: 'subject-already-admitted' };
        }
        if (error.constraint === 'consumed_peer_invitations_pkey') {
          return { ok: false, reason: 'invitation-already-used' };
        }
        return { ok: false, reason: 'admission-conflict' };
      }
      if (error?.code === 'ZION_ADMISSION_CONFIG_MISSING' ||
        error?.code === 'ZION_ADMISSION_COMMIT_OUTCOME_UNKNOWN') {
        return { ok: false, reason: 'admission-state-unavailable' };
      }
      throw error;
    }
  }

  /**
   * Authoritative read used by the transport after admission and to reconcile an
   * ambiguous COMMIT. This remains available even when writes are fail-closed.
   */
  async isAdmitted(subjectNodeId) {
    if (!NODE_ID.test(subjectNodeId ?? '')) return false;
    // Capture the exact unresolved outcome before starting the query. A read that
    // began before a later ambiguous COMMIT must never clear that newer marker.
    const unresolvedMarker = this.unknownCommitSubjects.get(subjectNodeId);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "SELECT 1 AS admitted FROM peer_admissions WHERE subject_node_id = $1 AND status = 'active' LIMIT 1",
        [subjectNodeId],
      );
      const admitted = Boolean(result.rows?.length);
      // PostgreSQL transactions are atomic: the authoritative row resolves whether
      // the ambiguous COMMIT for this subject took effect. Clear only after a
      // successful read; if the query fails, retain the fail-closed marker.
      if (unresolvedMarker !== undefined &&
        this.unknownCommitSubjects.get(subjectNodeId) === unresolvedMarker) {
        this.unknownCommitSubjects.delete(subjectNodeId);
      }
      return admitted;
    } finally {
      client.release();
    }
  }

  /**
   * Fail-closed startup preflight. Locks the policy/capacity rows in the same
   * order as admission transactions and verifies the reservation counter against
   * authoritative active rows before an official listener is opened.
   */
  async verifyPersistentState() {
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      began = true;
      const policyResult = await client.query(
        'SELECT max_active_peers, max_admissions_per_issuer, min_storage_headroom_ratio, policy_version FROM peer_admission_policy WHERE singleton = true FOR UPDATE',
      );
      const capacityResult = await client.query(
        'SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true FOR UPDATE',
      );
      const policy = policyResult.rows?.[0];
      const capacity = capacityResult.rows?.[0];
      if (!policy || !capacity) {
        throw Object.assign(new Error('Admission policy/capacity row missing during startup preflight'), {
          code: 'ZION_ADMISSION_CONFIG_MISSING',
        });
      }
      const maxActivePeers = Number(policy.max_active_peers);
      const maxAdmissionsPerIssuer = Number(policy.max_admissions_per_issuer);
      const minHeadroom = Number(policy.min_storage_headroom_ratio);
      const policyVersion = Number(policy.policy_version);
      const activeReservations = Number(capacity.active_reservations);
      if (!Number.isSafeInteger(maxActivePeers) || maxActivePeers < 1 ||
          !Number.isSafeInteger(maxAdmissionsPerIssuer) || maxAdmissionsPerIssuer < 1 ||
          !Number.isFinite(minHeadroom) || minHeadroom < 0 || minHeadroom > 1 ||
          !Number.isSafeInteger(policyVersion) || policyVersion < 1 ||
          !Number.isSafeInteger(activeReservations) || activeReservations < 0) {
        throw Object.assign(new Error('Admission policy/capacity values are invalid'), {
          code: 'ZION_ADMISSION_STATE_INCONSISTENT',
        });
      }
      const countResult = await client.query(
        "SELECT count(*)::bigint AS active_count FROM peer_admissions WHERE status = 'active'",
      );
      const activeCount = Number(countResult.rows?.[0]?.active_count);
      if (!Number.isSafeInteger(activeCount) || activeCount < 0 || activeCount !== activeReservations) {
        throw Object.assign(new Error('Active admission rows do not match the capacity reservation counter'), {
          code: 'ZION_ADMISSION_STATE_INCONSISTENT',
        });
      }
      const malformedResult = await client.query(
        `SELECT a.subject_node_id
         FROM peer_admissions a
         LEFT JOIN peer_admission_issuers i ON i.subject_node_id = a.subject_node_id
         LEFT JOIN consumed_peer_invitations c
           ON c.subject_node_id = a.subject_node_id AND c.issuer_node_id = i.issuer_node_id
         WHERE a.status = 'active'
         GROUP BY a.subject_node_id
         HAVING count(DISTINCT i.issuer_node_id) = 0
            OR count(DISTINCT i.issuer_node_id) <> count(DISTINCT c.issuer_node_id)
         LIMIT 1`,
      );
      if (malformedResult.rows?.length) {
        throw Object.assign(new Error('An active admission has inconsistent issuer/invitation records'), {
          code: 'ZION_ADMISSION_STATE_INCONSISTENT',
        });
      }
      await client.query('COMMIT');
      began = false;
      return Object.freeze({ ok: true, activeAdmissions: activeCount, activeReservations, policyVersion });
    } catch (error) {
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* preserve preflight failure */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseAdmission(subjectNodeId, status = 'released') {
    if (this.unknownCommitSubjects.has(subjectNodeId)) return { ok: false, reason: 'admission-state-unavailable' };
    if (!NODE_ID.test(subjectNodeId ?? '') || !['released', 'revoked'].includes(status)) {
      return { ok: false, reason: 'invalid-input' };
    }
    return this.#transaction(async client => {
      const capacityResult = await client.query(
        'SELECT active_reservations FROM peer_admission_capacity WHERE singleton = true FOR UPDATE',
      );
      if (!capacityResult.rows?.[0]) {
        throw Object.assign(new Error('Admission capacity row missing'), { code: 'ZION_ADMISSION_CONFIG_MISSING' });
      }
      const updated = await client.query(
        "UPDATE peer_admissions SET status = $2, updated_at = now() WHERE subject_node_id = $1 AND status = 'active' RETURNING subject_node_id",
        [subjectNodeId, status],
      );
      if (updated.rows?.length) {
        await client.query(
          'UPDATE peer_admission_capacity SET active_reservations = GREATEST(0, active_reservations - 1), updated_at = now() WHERE singleton = true',
        );
      }
      return { ok: true, changed: Boolean(updated.rows?.length), subjectNodeId, status };
    }, subjectNodeId).catch(error => {
      if (error?.code === 'ZION_ADMISSION_CONFIG_MISSING' ||
        error?.code === 'ZION_ADMISSION_COMMIT_OUTCOME_UNKNOWN') {
        return { ok: false, reason: 'admission-state-unavailable' };
      }
      throw error;
    });
  }
}
