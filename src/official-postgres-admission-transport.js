import { PeerTransport } from './peer-transport.js';
import { PostgresPeerAdmissionStore } from './peer-admission-postgres-store.js';
import { VerifiedPostgresPeerAdmissionService } from './verified-postgres-peer-admission-service.js';

/**
 * Compose the official peer transport with the verified, transactional admission
 * boundary. Pass the returned transport to OfficialNodeBootstrap; do not inject
 * the raw PostgresPeerAdmissionStore into PeerTransport.
 *
 * Database connection lifecycle/migrations remain deployment-owned. The caller
 * must apply migrations and provision trusted issuer IDs and genesis out of band.
 */
export function createOfficialPostgresAdmissionTransport({
  pool,
  identity,
  integrityGuard,
  protocolGenesis,
  trustedPeerIds,
  trustedIssuerNodeIds,
  storageHeadroomProvider,
  storeOptions = {},
  admissionOptions = {},
  transportOptions = {},
} = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A connected PostgreSQL-compatible pool is required');
  }
  if (!identity || !integrityGuard || !protocolGenesis ||
    !Array.isArray(trustedPeerIds) || trustedPeerIds.length === 0) {
    throw new TypeError('Official identity, integrity guard, genesis, and bootstrap peer allowlist are required');
  }
  if (Object.hasOwn(transportOptions, 'admissionController') ||
    Object.hasOwn(transportOptions, 'networkMode') ||
    Object.hasOwn(transportOptions, 'protocolGenesis') ||
    Object.hasOwn(transportOptions, 'integrityGuard') ||
    Object.hasOwn(transportOptions, 'trustedPeerIds')) {
    throw new TypeError('Security-critical transport options must be supplied through the factory arguments');
  }

  const store = new PostgresPeerAdmissionStore({ ...storeOptions, pool });
  const admissionService = new VerifiedPostgresPeerAdmissionService({
    ...admissionOptions,
    store,
    trustedIssuerNodeIds,
    storageHeadroomProvider,
  });
  const transport = new PeerTransport({
    ...transportOptions,
    identity,
    integrityGuard,
    protocolGenesis,
    trustedPeerIds,
    networkMode: 'official',
    admissionController: admissionService,
  });

  return Object.freeze({ transport, admissionService, store });
}
