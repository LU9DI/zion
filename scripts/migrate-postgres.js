import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS = Object.freeze([
  { id: '0001_peer_admission', path: resolve(here, '../migrations/postgres/0001_peer_admission.sql') },
]);
const MIGRATION_LOCK_ID = 741_029_331;

function migrationBody(sql, id) {
  const match = /^(?:\s|--[^\n]*(?:\n|$))*BEGIN;\s*([\s\S]*?)\s*COMMIT;\s*$/i.exec(sql);
  if (!match) {
    throw new Error(`Migration ${id} must have one outer BEGIN/COMMIT transaction wrapper`);
  }
  return match[1];
}

/**
 * Apply immutable, checksum-tracked SQL migrations under a PostgreSQL session
 * advisory lock. The lock and migration ledger prevent concurrent starts from
 * applying the same migration twice. A changed applied migration fails closed.
 */
export async function runPostgresMigrations({ pool, migrations = DEFAULT_MIGRATIONS } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('runPostgresMigrations requires a PostgreSQL pool');
  }
  if (!Array.isArray(migrations) || migrations.some(item =>
    !item || typeof item.id !== 'string' || !/^[a-z0-9_]+$/.test(item.id) ||
    typeof item.path !== 'string')) {
    throw new TypeError('Migrations must have safe IDs and file paths');
  }
  const migrationIds = migrations.map(item => item.id);
  if (new Set(migrationIds).size !== migrationIds.length) {
    throw new TypeError('Migration IDs must be unique within one run');
  }
  const client = await pool.connect();
  let locked = false;
  let operationError;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    await client.query(`CREATE TABLE IF NOT EXISTS zion_schema_migrations (
      migration_id text PRIMARY KEY,
      sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const applied = [];
    for (const migration of migrations) {
      const sql = await readFile(migration.path, 'utf8');
      const body = migrationBody(sql, migration.id);
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT sha256 FROM zion_schema_migrations WHERE migration_id = $1',
        [migration.id],
      );
      if (existing.rows.length) {
        if (String(existing.rows[0].sha256).trim() !== checksum) {
          throw Object.assign(new Error(`Applied migration ${migration.id} has changed; create a new migration instead`), {
            code: 'ZION_MIGRATION_CHECKSUM_MISMATCH',
          });
        }
        applied.push({ id: migration.id, status: 'already-applied' });
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(body);
        await client.query(
          'INSERT INTO zion_schema_migrations (migration_id, sha256) VALUES ($1, $2)',
          [migration.id, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
      }
      applied.push({ id: migration.id, status: 'applied' });
    }
    return Object.freeze({ ok: true, migrations: Object.freeze(applied) });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let releaseError;
    if (locked) {
      try {
        const unlock = await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
        if (unlock.rows?.[0]?.pg_advisory_unlock !== true) {
          releaseError = new Error('PostgreSQL migration advisory lock release was not confirmed');
        }
      } catch (error) {
        releaseError = error;
      }
    }
    // node-postgres destroys a client released with an error instead of returning
    // a possibly still-locked session to the pool.
    client.release(releaseError);
    if (releaseError && !operationError) {
      throw Object.assign(new Error('PostgreSQL migration completed but advisory lock release could not be confirmed; the database state must be inspected before retrying'), {
        code: 'ZION_MIGRATION_LOCK_RELEASE_FAILED',
        cause: releaseError,
      });
    }
  }
}

async function main() {
  const connectionString = process.env.ZION_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set ZION_POSTGRES_URL (or DATABASE_URL) to run PostgreSQL migrations');
  }
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await runPostgresMigrations({ pool });
    for (const migration of result.migrations) {
      process.stdout.write(`${migration.status}: ${migration.id}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`PostgreSQL migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
