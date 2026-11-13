import { validate as validateUuid } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
}

function toProject(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    ownerId: row.owner_id,
    lifecycleStatus: row.lifecycle_status,
    lastMeaningfulActivityAt: row.last_meaningful_activity_at instanceof Date
      ? row.last_meaningful_activity_at.toISOString()
      : new Date(row.last_meaningful_activity_at).toISOString(),
    pausedAt: row.paused_at,
    storageReleasedAt: row.storage_released_at,
    policyVersion: Number(row.policy_version),
  };
}

/**
 * PostgreSQL implementation of the project lifecycle repository contract.
 * All state transitions and activity writes share one transaction-scoped
 * advisory lock, so scheduler workers and user activity serialize per project.
 *
 * The supplied pool must be node-postgres compatible. Migration 0002 must be
 * applied before this adapter is used. No storage operation is implemented here.
 */
export class PostgresProjectResourceRepository {
  constructor({ pool, maxTransactionMs = 30_000 } = {}) {
    if (!pool || typeof pool.connect !== 'function' ||
        !Number.isSafeInteger(maxTransactionMs) || maxTransactionMs < 1000 ||
        maxTransactionMs > 120_000) {
      throw new TypeError('Invalid PostgreSQL project-resource repository configuration');
    }
    this.pool = pool;
    this.maxTransactionMs = maxTransactionMs;
  }

  async withProjectLock(projectId, work) {
    assertUuid(projectId, 'projectId');
    if (typeof work !== 'function') throw new TypeError('work must be a function');

    const client = await this.pool.connect();
    let began = false;
    let commitStarted = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      began = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(this.maxTransactionMs),
      ]);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`zion-project:${projectId}`],
      );

      const tx = Object.freeze({
        getProject: async id => {
          assertUuid(id, 'projectId');
          const result = await client.query(
            `SELECT project_id, owner_id, lifecycle_status, last_meaningful_activity_at,
                    paused_at, storage_released_at, policy_version
               FROM zion_projects WHERE project_id = $1 FOR UPDATE`,
            [id],
          );
          return toProject(result.rows?.[0]);
        },

        recordActivity: async event => {
          assertUuid(event.projectId, 'event.projectId');
          assertUuid(event.eventId, 'event.eventId');
          if (typeof event.actorId !== 'string' || !event.actorId.trim() ||
              event.actorId.length > 128 ||
              !['owner', 'collaborator'].includes(event.actorKind) ||
              typeof event.idempotencyKey !== 'string' ||
              event.idempotencyKey.length < 16 || event.idempotencyKey.length > 256 ||
              !Number.isSafeInteger(event.recordedAt) || event.recordedAt < 0) {
            throw new TypeError('Invalid project activity event');
          }
          const result = await client.query(
            `INSERT INTO project_activity_events
               (event_id, project_id, actor_id, actor_kind, activity_type,
                idempotency_key, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
             ON CONFLICT (project_id, actor_id, idempotency_key) DO NOTHING
             RETURNING event_id`,
            [event.eventId, event.projectId, event.actorId, event.actorKind,
              event.activityType, event.idempotencyKey, event.recordedAt],
          );
          return result.rows?.length === 1;
        },

        updateLastMeaningfulActivity: async (id, at) => {
          assertUuid(id, 'projectId');
          if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Invalid activity timestamp');
          await client.query(
            `UPDATE zion_projects
                SET last_meaningful_activity_at = GREATEST(last_meaningful_activity_at, to_timestamp($2 / 1000.0)),
                    updated_at = now()
              WHERE project_id = $1 AND lifecycle_status <> 'storage_released'`,
            [id, at],
          );
        },

        pauseProject: async (id, at) => {
          assertUuid(id, 'projectId');
          await client.query(
            `UPDATE zion_projects SET lifecycle_status = 'paused',
                    paused_at = COALESCE(paused_at, to_timestamp($2 / 1000.0)), updated_at = now()
              WHERE project_id = $1 AND lifecycle_status = 'active'`,
            [id, at],
          );
        },

        markStorageReleasePending: async (id, at) => {
          assertUuid(id, 'projectId');
          await client.query(
            `UPDATE zion_projects SET lifecycle_status = 'storage_release_pending',
                    paused_at = COALESCE(paused_at, to_timestamp($2 / 1000.0)), updated_at = now()
              WHERE project_id = $1 AND lifecycle_status IN ('paused', 'storage_release_pending')`,
            [id, at],
          );
          await client.query(
            `UPDATE project_storage_leases SET lease_status = 'release_pending'
              WHERE project_id = $1 AND lease_status IN ('reserved', 'active')`,
            [id],
          );
        },

        cancelStorageReleasePending: async id => {
          assertUuid(id, 'projectId');
          await client.query(
            `UPDATE zion_projects SET lifecycle_status = 'paused', updated_at = now()
              WHERE project_id = $1 AND lifecycle_status = 'storage_release_pending'`,
            [id],
          );
          await client.query(
            `UPDATE project_storage_leases SET lease_status = 'active'
              WHERE project_id = $1 AND lease_status = 'release_pending'`,
            [id],
          );
        },

        listLiveStorageLeases: async id => {
          assertUuid(id, 'projectId');
          const result = await client.query(
            `SELECT lease_id, project_id, node_id, reserved_bytes, lease_status, policy_version
               FROM project_storage_leases
              WHERE project_id = $1 AND lease_status IN ('reserved', 'active', 'release_pending')
              ORDER BY lease_id`,
            [id],
          );
          return (result.rows ?? []).map(row => ({
            leaseId: row.lease_id,
            projectId: row.project_id,
            nodeId: row.node_id,
            reservedBytes: Number(row.reserved_bytes),
            leaseStatus: row.lease_status,
            policyVersion: Number(row.policy_version),
          }));
        },

        markStorageLeasesReleased: async (id, leaseIds, at) => {
          assertUuid(id, 'projectId');
          if (!Array.isArray(leaseIds) || leaseIds.some(x => !UUID.test(x)) ||
              !Number.isSafeInteger(at) || at < 0) {
            throw new TypeError('Invalid storage lease release request');
          }
          if (leaseIds.length === 0) return;
          const result = await client.query(
            `UPDATE project_storage_leases
                SET lease_status = 'released', released_at = to_timestamp($3 / 1000.0)
              WHERE project_id = $1 AND lease_id = ANY($2::uuid[])
                AND lease_status IN ('reserved', 'active', 'release_pending')`,
            [id, leaseIds, at],
          );
          if (result.rowCount !== leaseIds.length) {
            throw new Error('Storage lease set changed before release could be committed');
          }
        },

        markProjectStorageReleased: async (id, at) => {
          assertUuid(id, 'projectId');
          const result = await client.query(
            `UPDATE zion_projects SET lifecycle_status = 'storage_released',
                    storage_released_at = to_timestamp($2 / 1000.0), updated_at = now()
              WHERE project_id = $1 AND lifecycle_status = 'storage_release_pending'`,
            [id, at],
          );
          if (result.rowCount !== 1) throw new Error('Project lifecycle changed before storage release commit');
        },

        recordResourceEvent: async event => {
          assertUuid(event.projectId, 'event.projectId');
          assertUuid(event.eventId, 'event.eventId');
          if (!Number.isSafeInteger(event.recordedAt) || event.recordedAt < 0) {
            throw new TypeError('Invalid resource event timestamp');
          }
          await client.query(
            `INSERT INTO project_resource_events
               (event_id, project_id, event_type, policy_version, recorded_at)
             VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0))`,
            [event.eventId, event.projectId, event.eventType, event.policyVersion, event.recordedAt],
          );
        },
      });

      const value = await work(tx);
      commitStarted = true;
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (commitStarted) {
        throw Object.assign(new Error('Project transaction commit outcome is unknown; reconcile durable state before retrying'), {
          code: 'ZION_PROJECT_COMMIT_OUTCOME_UNKNOWN', cause: error,
        });
      }
      if (began) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listDueProjects({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer between 1 and 1000');
    }
    const result = await this.pool.query(
      `SELECT project_id
         FROM zion_projects
        WHERE lifecycle_status IN ('active', 'paused', 'storage_release_pending')
          AND last_meaningful_activity_at <= now() - interval '7 days'
        ORDER BY last_meaningful_activity_at, project_id
        LIMIT $1`,
      [limit],
    );
    return (result.rows ?? []).map(row => row.project_id);
  }
}
