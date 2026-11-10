import { PeerTransport } from './peer-transport.js';
import { PostgresPeerAdmissionController } from './peer-admission-postgres-controller.js';
import { PostgresPeerRevocationListener } from './peer-admission-postgres-listener.js';
import { PostgresPeerAdmissionStore } from './peer-admission-postgres-store.js';

/**
 * Compose the PostgreSQL-backed admission path for an official node.
 *
 * The caller owns the pg-compatible pool and all deployment-specific trust,
 * identity, TLS, storage, and capacity configuration. Pass the returned
 * transport to OfficialNodeBootstrap; do not create a second transport.
 */
export function createPostgresPeerAdmissionRuntime({
  pool,
  storeOptions = {},
  controllerOptions,
  listenerOptions = {},
  transportOptions,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A node-postgres-compatible pool is required');
  }
  const isOptionsObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isOptionsObject(storeOptions)) {
    throw new TypeError('PostgreSQL store options must be an object');
  }
  if (!isOptionsObject(controllerOptions)) {
    throw new TypeError('PostgreSQL admission controller options are required');
  }
  if (!isOptionsObject(listenerOptions)) {
    throw new TypeError('PostgreSQL listener options must be an object');
  }
  if (!isOptionsObject(transportOptions)) {
    throw new TypeError('Official peer transport options are required');
  }
  if (transportOptions.networkMode !== undefined && transportOptions.networkMode !== 'official') {
    throw new TypeError('PostgreSQL admission runtime requires official transport mode');
  }
  if (transportOptions.admissionController !== undefined ||
      transportOptions.revocationListener !== undefined) {
    throw new TypeError('Admission controller and revocation listener are managed by this runtime');
  }
  if (Object.hasOwn(listenerOptions, 'pool')) {
    throw new TypeError('The runtime owns the revocation listener pool');
  }

  const store = new PostgresPeerAdmissionStore({ ...storeOptions, pool });
  const admissionController = new PostgresPeerAdmissionController({
    ...controllerOptions,
    store,
  });
  const revocationListener = new PostgresPeerRevocationListener({
    ...listenerOptions,
    pool,
  });
  const transport = new PeerTransport({
    ...transportOptions,
    networkMode: 'official',
    admissionController,
    revocationListener,
  });

  return Object.freeze({
    store,
    admissionController,
    revocationListener,
    transport,
  });
}
