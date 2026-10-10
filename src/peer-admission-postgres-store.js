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
  }

  async #transaction(work) {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      let began = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        began = true;
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
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
      });
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
      if (error?.code === 'ZION_ADMISSION_CONFIG_MISSING') {
        return { ok: false, reason: 'admission-state-unavailable' };
      }
      throw error;
    }
  }

  async releaseAdmission(subjectNodeId, status = 'released') {
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
    }).catch(error => {
      if (error?.code === 'ZION_ADMISSION_CONFIG_MISSING') {
        return { ok: false, reason: 'admission-state-unavailable' };
      }
      throw error;
    });
  }
}
