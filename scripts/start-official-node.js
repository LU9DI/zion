import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OfficialNodeBootstrap } from '../src/official-node-bootstrap.js';
import { createPostgresPeerAdmissionRuntime } from '../src/postgres-peer-admission-runtime.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`Official deployment adapter must provide ${name}()`);
}

function validateDependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Official deployment adapter must return a dependency object');
  }
  const { integrityGuard, identity, protocolGenesis, trustedPeerIds, startStorage, stopStorage,
    controllerOptions, transportOptions } = value;
  if (!integrityGuard || typeof integrityGuard.verify !== 'function' ||
      typeof integrityGuard.checkHealthy !== 'function' || typeof integrityGuard.assertHealthy !== 'function' ||
      typeof integrityGuard.addQuarantineListener !== 'function' || !integrityGuard.status) {
    throw new TypeError('Deployment adapter must provide a complete IntegrityGuard');
  }
  if (!identity?.privateKey || (typeof identity.privateKey === 'string' && !identity.privateKey.trim()) ||
      typeof identity.nodeId !== 'string' || !identity.nodeId.trim()) {
    throw new TypeError('Deployment adapter must provide a node identity');
  }
  if (!protocolGenesis || !Array.isArray(trustedPeerIds) || trustedPeerIds.length === 0 ||
      trustedPeerIds.some(peerId => typeof peerId !== 'string' || !peerId.trim())) {
    throw new TypeError('Deployment adapter must provide reviewed genesis and a non-empty peer trust list');
  }
  requireFunction(startStorage, 'startStorage');
  requireFunction(stopStorage, 'stopStorage');
  if (!controllerOptions || typeof controllerOptions !== 'object' || Array.isArray(controllerOptions) ||
      !Array.isArray(controllerOptions.trustedIssuerNodeIds) || controllerOptions.trustedIssuerNodeIds.length === 0 ||
      controllerOptions.trustedIssuerNodeIds.some(nodeId => typeof nodeId !== 'string' || !nodeId.trim()) ||
      typeof controllerOptions.capacityProvider !== 'function') {
    throw new TypeError('Deployment adapter must provide controllerOptions with trustedIssuerNodeIds and capacityProvider()');
  }
  if (!transportOptions || typeof transportOptions !== 'object' || Array.isArray(transportOptions)) {
    throw new TypeError('Deployment adapter must provide transportOptions');
  }
  if (transportOptions.identity || transportOptions.protocolGenesis || transportOptions.trustedPeerIds ||
      transportOptions.admissionController || transportOptions.revocationListener) {
    throw new TypeError('Identity, genesis, trust, and admission wiring are owned by the launcher');
  }
  for (const name of ['storeOptions', 'listenerOptions', 'bootstrapOptions']) {
    if (value[name] !== undefined && (!value[name] || typeof value[name] !== 'object' || Array.isArray(value[name]))) {
      throw new TypeError(`Deployment adapter ${name} must be an object when provided`);
    }
  }
  for (const name of ['getStorageStatus', 'recordContainmentEvent']) {
    if (value[name] !== undefined && typeof value[name] !== 'function') {
      throw new TypeError(`Deployment adapter ${name} must be a function when provided`);
    }
  }
}

/**
 * Compose and start the official node. The deployment-owned adapter supplies
 * reviewed trust material and storage/integrity adapters; it never supplies
 * the PostgreSQL admission controller or revocation listener.
 */
export async function startOfficialNode({ env = process.env, loadAdapterModule = specifier => import(specifier) } = {}) {
  const adapterPath = env.ZION_OFFICIAL_ADAPTER_MODULE;
  if (typeof adapterPath !== 'string' || !adapterPath.trim() || !isAbsolute(adapterPath)) {
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

  const adapterModule = await loadAdapterModule(pathToFileURL(resolve(adapterPath)).href);
  requireFunction(adapterModule?.createPool, 'createPool');
  requireFunction(adapterModule?.createOfficialNodeDependencies, 'createOfficialNodeDependencies');

  let pool;
  let bootstrap;
  let runtime;
  try {
    pool = await adapterModule.createPool({
      connectionString, max: Number(poolMaxRaw), connectionTimeoutMillis: 5000,
      application_name: 'zion-official-node', env,
    });
    if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
      throw new TypeError('Deployment adapter createPool() must return a pg-compatible pool with connect() and end()');
    }
    const dependencies = await adapterModule.createOfficialNodeDependencies({ env, pool });
    validateDependencies(dependencies);
    runtime = createPostgresPeerAdmissionRuntime({
      pool,
      storeOptions: dependencies.storeOptions,
      controllerOptions: dependencies.controllerOptions,
      listenerOptions: dependencies.listenerOptions,
      transportOptions: {
        ...dependencies.transportOptions,
        integrityGuard: dependencies.integrityGuard,
        identity: dependencies.identity,
        protocolGenesis: dependencies.protocolGenesis,
        trustedPeerIds: dependencies.trustedPeerIds,
        networkMode: 'official',
      },
    });
    bootstrap = new OfficialNodeBootstrap({
      ...dependencies.bootstrapOptions,
      integrityGuard: dependencies.integrityGuard,
      transport: runtime.transport,
      startStorage: dependencies.startStorage,
      stopStorage: dependencies.stopStorage,
      getStorageStatus: dependencies.getStorageStatus,
      recordContainmentEvent: dependencies.recordContainmentEvent,
    });
    const started = await bootstrap.start();
    let closePromise;
    const close = () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // PostgreSQL also backs the revocation listener. Retain it if containment
        // cannot be confirmed; closing it could strand a live transport.
        await bootstrap.close();
        await pool.end();
      })().finally(() => { closePromise = null; });
      return closePromise;
    };
    return Object.freeze({ ...started, bootstrap, runtime, close });
  } catch (error) {
    let cleanupConfirmed = true;
    if (bootstrap) {
      try { await bootstrap.close(); } catch { cleanupConfirmed = false; }
    } else if (runtime) {
      try { await runtime.transport.close(); } catch { cleanupConfirmed = false; }
    }
    if (cleanupConfirmed) {
      try { await pool?.end?.(); } catch { /* preserve the startup error */ }
    }
    throw error;
  }
}

export function installShutdownHandlers(running, { processLike = process, stdout = process.stdout, stderr = process.stderr } = {}) {
  let shuttingDown = false;
  let closed = false;
  const shutdown = async signal => {
    if (shuttingDown || closed) return;
    shuttingDown = true;
    stdout.write(`Official Zion node shutting down (${signal})\n`);
    try {
      await running.close();
      closed = true;
      processLike.off?.('SIGINT', onSigint);
      processLike.off?.('SIGTERM', onSigterm);
    } catch {
      processLike.exitCode = 1;
      stderr.write('Official node shutdown was incomplete; inspect deployment logs and resource status.\n');
    } finally { shuttingDown = false; }
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
