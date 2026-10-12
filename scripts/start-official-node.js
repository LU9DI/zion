import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OfficialNodeBootstrap } from '../src/official-node-bootstrap.js';
import { createOfficialPostgresAdmissionTransport } from '../src/official-postgres-admission-transport.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`Official deployment adapter must provide ${name}()`);
}

function validateDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') {
    throw new TypeError('Official deployment adapter must return a dependency object');
  }
  const {
    integrityGuard, identity, protocolGenesis, trustedPeerIds, trustedIssuerNodeIds,
    storageHeadroomProvider, startStorage, stopStorage,
  } = dependencies;
  if (!integrityGuard || typeof integrityGuard.verify !== 'function' ||
      typeof integrityGuard.checkHealthy !== 'function' ||
      typeof integrityGuard.assertHealthy !== 'function' ||
      typeof integrityGuard.addQuarantineListener !== 'function' ||
      !integrityGuard.status || typeof integrityGuard.status !== 'object') {
    throw new TypeError('Deployment adapter must provide a complete IntegrityGuard');
  }
  if (!identity?.privateKey || typeof identity.nodeId !== 'string') {
    throw new TypeError('Deployment adapter must provide a node identity');
  }
  if (!protocolGenesis || !Array.isArray(trustedPeerIds) || trustedPeerIds.length === 0 ||
      !Array.isArray(trustedIssuerNodeIds) || trustedIssuerNodeIds.length === 0) {
    throw new TypeError('Deployment adapter must provide reviewed genesis and non-empty peer/issuer trust lists');
  }
  requireFunction(storageHeadroomProvider, 'storageHeadroomProvider');
  requireFunction(startStorage, 'startStorage');
  requireFunction(stopStorage, 'stopStorage');
  for (const name of ['getStorageStatus', 'recordContainmentEvent']) {
    if (dependencies[name] !== undefined && typeof dependencies[name] !== 'function') {
      throw new TypeError(`Deployment adapter ${name} must be a function when provided`);
    }
  }
  for (const name of ['storeOptions', 'admissionOptions', 'transportOptions', 'bootstrapOptions']) {
    if (dependencies[name] !== undefined &&
        (!dependencies[name] || typeof dependencies[name] !== 'object' || Array.isArray(dependencies[name]))) {
      throw new TypeError(`Deployment adapter ${name} must be an object when provided`);
    }
  }
}

/**
 * Start an official node using a deployment-owned adapter module.
 *
 * The adapter module and every trust/configuration file it reads must be owned
 * and permissioned by the deployment, not writable by the running node account.
 * Database migrations are intentionally a separate release operation.
 */
export async function startOfficialNode({
  env = process.env,
  loadAdapterModule = specifier => import(specifier),
  PoolClass,
} = {}) {
  const adapterPath = env.ZION_OFFICIAL_ADAPTER_MODULE;
  if (typeof adapterPath !== 'string' || !isAbsolute(adapterPath) || !adapterPath.trim()) {
    throw new Error('Set ZION_OFFICIAL_ADAPTER_MODULE to an absolute path to a deployment-owned adapter module');
  }
  const connectionString = env.ZION_POSTGRES_URL ?? env.DATABASE_URL;
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('Set ZION_POSTGRES_URL (or DATABASE_URL) for the official node');
  }
  const poolMaxRaw = env.ZION_POSTGRES_POOL_MAX ?? '10';
  if (!/^[1-9][0-9]*$/.test(poolMaxRaw) || !Number.isSafeInteger(Number(poolMaxRaw)) || Number(poolMaxRaw) > 100) {
    throw new Error('ZION_POSTGRES_POOL_MAX must be an integer between 1 and 100');
  }

  const adapterUrl = pathToFileURL(resolve(adapterPath)).href;
  const adapterModule = await loadAdapterModule(adapterUrl);
  requireFunction(adapterModule?.createOfficialNodeDependencies, 'createOfficialNodeDependencies');

  let ActualPoolClass = PoolClass;
  if (!ActualPoolClass) {
    ({ Pool: ActualPoolClass } = await import('pg'));
  }
  const pool = new ActualPoolClass({
    connectionString,
    max: Number(poolMaxRaw),
    connectionTimeoutMillis: 5000,
    application_name: 'zion-official-node',
  });
  let bootstrap;
  let composition;
  let closePromise;
  try {
    const dependencies = await adapterModule.createOfficialNodeDependencies({ env, pool });
    validateDependencies(dependencies);
    composition = createOfficialPostgresAdmissionTransport({
      pool,
      identity: dependencies.identity,
      integrityGuard: dependencies.integrityGuard,
      protocolGenesis: dependencies.protocolGenesis,
      trustedPeerIds: dependencies.trustedPeerIds,
      trustedIssuerNodeIds: dependencies.trustedIssuerNodeIds,
      storageHeadroomProvider: dependencies.storageHeadroomProvider,
      storeOptions: dependencies.storeOptions,
      admissionOptions: dependencies.admissionOptions,
      transportOptions: dependencies.transportOptions,
    });
    bootstrap = new OfficialNodeBootstrap({
      ...dependencies.bootstrapOptions,
      integrityGuard: dependencies.integrityGuard,
      transport: composition.transport,
      startStorage: dependencies.startStorage,
      stopStorage: dependencies.stopStorage,
      getStorageStatus: dependencies.getStorageStatus,
      recordContainmentEvent: dependencies.recordContainmentEvent,
    });
    const started = await bootstrap.start();
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // The pool backs transport/admission and storage cleanup. Do not end it
        // while bootstrap still reports incomplete containment.
        await bootstrap.close();
        await pool.end();
      })().finally(() => {
        // A failed close is retryable; do not permanently memoize a transient
        // adapter failure and strand resources in an uncertain state.
        closePromise = null;
      });
      return closePromise;
    };
    return Object.freeze({ ...started, bootstrap, close });
  } catch (error) {
    let cleanupConfirmed = true;
    if (bootstrap) {
      try { await bootstrap.close(); } catch { cleanupConfirmed = false; /* preserve startup failure */ }
    } else if (composition) {
      try { await composition.transport.close(); } catch { cleanupConfirmed = false; /* preserve startup failure */ }
    }
    // If listeners or storage may still be active, retain their backing pool
    // rather than severing live handlers from PostgreSQL during failed cleanup.
    if (cleanupConfirmed) {
      try { await pool.end(); } catch { /* preserve startup failure */ }
    }
    throw error;
  }
}

export function installShutdownHandlers(running, {
  processLike = process,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let shuttingDown = false;
  let closed = false;
  let shutdownFailureSetExitCode = false;
  const shutdown = async signal => {
    if (shuttingDown || closed) return;
    shuttingDown = true;
    stdout.write(`Official Zion node shutting down (${signal})\n`);
    try {
      await running.close();
      closed = true;
      if (shutdownFailureSetExitCode && processLike.exitCode === 1) processLike.exitCode = undefined;
      processLike.off?.('SIGINT', onSigint);
      processLike.off?.('SIGTERM', onSigterm);
    } catch {
      // Keep both handlers installed so a later signal can retry cleanup.
      processLike.exitCode = 1;
      stderr.write('Official node shutdown was incomplete; inspect deployment logs and resource status.\n');
    } finally {
      shuttingDown = false;
    }
  };
  const onSigint = () => { shutdown('SIGINT').catch(() => { processLike.exitCode = 1; }); };
  const onSigterm = () => { shutdown('SIGTERM').catch(() => { processLike.exitCode = 1; }); };
  processLike.on('SIGINT', onSigint);
  processLike.on('SIGTERM', onSigterm);
  return shutdown;
}

async function main() {
  const running = await startOfficialNode();
  process.stdout.write(`Official Zion node listening on ${running.address.host}:${running.address.port}\n`);
  installShutdownHandlers(running);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('Official Zion node startup failed; inspect deployment logs for diagnostics.\n');
    process.exitCode = 1;
  });
}
