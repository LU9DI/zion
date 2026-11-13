import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectInactivityController } from '../src/project-inactivity-controller.js';
import { PostgresProjectResourceRepository } from '../src/project-resource-postgres-repository.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`Project resource adapter must export ${name}()`);
}

/**
 * One bounded lifecycle sweep. Invoke from a durable external scheduler
 * (for example, a platform cron job). Re-running is safe because project
 * transitions are idempotent and serialized by the repository's project lock.
 */
export async function runProjectResourceSweep({ pool, storage, limit = 100, now } = {}) {
  if (!pool || typeof pool.connect !== 'function' ||
      !storage || typeof storage.relocateAndVerify !== 'function' ||
      typeof storage.releaseCapacity !== 'function') {
    throw new TypeError('A PostgreSQL pool and verified storage adapter are required');
  }
  const repository = new PostgresProjectResourceRepository({ pool });
  const controller = new ProjectInactivityController({
    repository, storage, ...(typeof now === 'function' ? { now } : {}),
  });
  const projectIds = await repository.listDueProjects({ limit });
  const results = [];
  for (const projectId of projectIds) {
    try {
      results.push({ projectId, ...(await controller.evaluateProject(projectId)) });
    } catch (error) {
      results.push({
        projectId,
        status: 'evaluation-failed',
        errorCode: typeof error?.code === 'string' ? error.code : 'UNCLASSIFIED',
      });
    }
  }
  return Object.freeze({
    scanned: projectIds.length,
    results: Object.freeze(results),
  });
}

async function main() {
  const adapterPath = process.env.ZION_PROJECT_RESOURCE_ADAPTER_MODULE;
  const connectionString = process.env.ZION_POSTGRES_URL ?? process.env.DATABASE_URL;
  if (typeof adapterPath !== 'string' || !isAbsolute(adapterPath)) {
    throw new Error('ZION_PROJECT_RESOURCE_ADAPTER_MODULE must be an absolute adapter path');
  }
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('ZION_POSTGRES_URL (or DATABASE_URL) is required');
  }
  const adapter = await import(pathToFileURL(resolve(adapterPath)).href);
  requireFunction(adapter?.createPool, 'createPool');
  requireFunction(adapter?.createProjectResourceStorageAdapter, 'createProjectResourceStorageAdapter');

  const pool = await adapter.createPool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 5000,
    application_name: 'zion-project-resource-scheduler',
  });
  if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
    throw new TypeError('createPool() must return a pg-compatible pool');
  }
  try {
    const storage = await adapter.createProjectResourceStorageAdapter({ pool, env: process.env });
    const rawLimit = process.env.ZION_PROJECT_SWEEP_LIMIT ?? '100';
    if (!/^[1-9][0-9]*$/.test(rawLimit)) throw new Error('ZION_PROJECT_SWEEP_LIMIT must be a positive integer');
    const result = await runProjectResourceSweep({ pool, storage, limit: Number(rawLimit) });
    process.stdout.write(`Zion project lifecycle sweep scanned ${result.scanned} project(s)\n`);
    for (const item of result.results) {
      process.stdout.write(`${item.projectId} ${item.status}\n`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`Zion project lifecycle sweep failed: ${error?.message ?? 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
