import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresProjectResourceRepository } from '../src/project-resource-postgres-repository.js';

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';

function poolHarness({ duplicate = false, failQuery = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (failQuery && normalized.startsWith(failQuery)) throw new Error('injected query failure');
      if (normalized.startsWith('SELECT project_id')) {
        return { rows: [{
          project_id: PROJECT_ID, owner_id: 'owner-1', lifecycle_status: 'active',
          last_meaningful_activity_at: new Date(0), paused_at: null,
          storage_released_at: null, policy_version: '1',
        }] };
      }
      if (normalized.startsWith('INSERT INTO project_activity_events')) {
        return { rows: duplicate ? [] : [{ event_id: params[0] }] };
      }
      if (normalized.startsWith('UPDATE zion_projects')) return { rowCount: 1, rows: [] };
      if (normalized.startsWith('UPDATE project_storage_leases')) return { rowCount: params[1]?.length ?? 1, rows: [] };
      if (normalized.startsWith('INSERT INTO project_resource_events')) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return { pool: { async connect() { return client; }, async query() { return { rows: [] }; } }, calls };
}

test('serializes project work under a transaction-scoped advisory lock', async () => {
  const h = poolHarness();
  const repository = new PostgresProjectResourceRepository({ pool: h.pool });
  const result = await repository.withProjectLock(PROJECT_ID, async tx => {
    const project = await tx.getProject(PROJECT_ID);
    assert.equal(project.lifecycleStatus, 'active');
    assert.equal(project.ownerId, 'owner-1');
    return 'ok';
  });
  assert.equal(result, 'ok');
  const sql = h.calls.map(x => x.sql);
  assert.equal(sql[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.ok(sql.some(x => x.includes('pg_advisory_xact_lock(hashtextextended($1, 0))')));
  assert.equal(sql.at(-2), 'COMMIT');
  assert.equal(sql.at(-1), 'RELEASE');
});

test('activity insert reports duplicate idempotency keys as false', async () => {
  const h = poolHarness({ duplicate: true });
  const repository = new PostgresProjectResourceRepository({ pool: h.pool });
  const accepted = await repository.withProjectLock(PROJECT_ID, tx => tx.recordActivity({
    eventId: '123e4567-e89b-42d3-a456-426614174001',
    projectId: PROJECT_ID,
    actorId: 'owner-1',
    actorKind: 'owner',
    activityType: 'configuration_committed',
    idempotencyKey: 'config-change-000001',
    recordedAt: 1_700_000_000_000,
  }));
  assert.equal(accepted, false);
  assert.ok(h.calls.some(x => x.sql.includes('ON CONFLICT (project_id, actor_id, idempotency_key) DO NOTHING')));
});

test('rolls back when repository work fails and always releases the client', async () => {
  const h = poolHarness();
  const repository = new PostgresProjectResourceRepository({ pool: h.pool });
  await assert.rejects(repository.withProjectLock(PROJECT_ID, async () => {
    throw new Error('work failed');
  }), /work failed/);
  const sql = h.calls.map(x => x.sql);
  assert.ok(sql.includes('ROLLBACK'));
  assert.equal(sql.at(-1), 'RELEASE');
});

test('rejects invalid project identifiers before acquiring a connection', async () => {
  const h = poolHarness();
  const repository = new PostgresProjectResourceRepository({ pool: h.pool });
  await assert.rejects(repository.withProjectLock('not-a-uuid', async () => {}), /UUID/);
  assert.equal(h.calls.length, 0);
});

test('rejects invalid pool configuration', () => {
  assert.throws(() => new PostgresProjectResourceRepository(), /configuration/);
});
