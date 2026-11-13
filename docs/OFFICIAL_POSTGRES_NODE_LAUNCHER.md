# Official PostgreSQL node launcher

The repository now exposes `npm run start:official`. It composes the current
`createPostgresPeerAdmissionRuntime()` with `OfficialNodeBootstrap`; it does
not reuse the older pre-runtime admission transport.

## Deployment-owned adapter

Set `ZION_OFFICIAL_ADAPTER_MODULE` to an absolute path to a deployment-owned
ES module. The module must export:

- `createPool({ connectionString, max, connectionTimeoutMillis, application_name, env })`
  returning a node-postgres-compatible pool with `connect()` and `end()`.
- `createOfficialNodeDependencies({ env, pool })` returning:
  - `integrityGuard`: a fully configured `IntegrityGuard` with externally
    pinned release-manifest trust material;
  - `identity`, `protocolGenesis`, and a non-empty reviewed `trustedPeerIds`;
  - `controllerOptions` with non-empty `trustedIssuerNodeIds` and a real
    `capacityProvider()`;
  - `transportOptions`: TLS key/certificate/CA, bind address, limits, and
    application message handler. Identity, genesis, trust allowlist, integrity
    guard, admission controller, and revocation listener are launcher-owned;
  - `startStorage()` and `stopStorage()` backed by the deployment's real
    storage service. `stopStorage()` must be safe to call after a partially
    completed or failed `startStorage()`; startup rollback invokes it whenever
    storage initialization has begun.
  - Optional `storeOptions`, `listenerOptions`, `bootstrapOptions`,
    `getStorageStatus()`, and `recordContainmentEvent()`.

Example adapter shape (illustrative only; all values and implementations must
come from the deployment's reviewed configuration):

```js
import { Pool } from 'pg';
import { createDeploymentDependencies } from './deployment-dependencies.js';

export function createPool(options) {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    application_name: options.application_name,
    ssl: { rejectUnauthorized: true, ca: process.env.ZION_POSTGRES_CA },
  });
}

export async function createOfficialNodeDependencies({ env, pool }) {
  return createDeploymentDependencies({ env, pool });
}
```

Set `ZION_POSTGRES_URL` (or `DATABASE_URL`) and optionally
`ZION_POSTGRES_POOL_MAX` (2–100; default 10). The minimum is two because the
revocation listener holds one dedicated pool connection for `LISTEN`; a pool of
one would starve admission queries. Size the pool above two for concurrent
admission-fenced handlers. Apply the PostgreSQL admission migration as a
separate, reviewed release operation before starting the node.

## Security and lifecycle requirements

- Keep the adapter, manifest, signing trust anchor, identity private key,
  TLS private key, genesis, trust lists, and database credentials outside the
  repository and inaccessible to the node's untrusted workload.
- Message handlers receive a message field named `signal`, an `AbortSignal`. The transport aborts it and closes the peer socket when `handlerTimeoutMs` expires (default 30 seconds; allowed range 100 ms–5 minutes) or the socket closes. Handlers must propagate this signal to database queries, storage operations, and downstream work, and stop promptly when aborted.
- `maxConcurrentHandlers` bounds active application callbacks across the process (default 16; allowed range 1–1024). Excess frames are rejected by closing the sending socket before a new authorization fence is acquired. Tune this below the database pool's available capacity, accounting for the dedicated revocation-listener connection and other application queries.
- The timeout is cooperative, not a mechanism for forcibly terminating JavaScript. The transport deliberately continues awaiting a handler after abort so it cannot release a PostgreSQL authorization fence while that handler is still running. A handler that ignores its signal can therefore continue holding a database connection/lock and a concurrency slot; production adapters must enforce their own query/operation deadlines and cancellation. Do not mistake socket closure for proof that application work stopped.
- Public binding requires mutual TLS material and an explicit peer allowlist.
  A real production adapter must also provision and rotate certificates and
  peer trust safely.
- The admission controller and revocation listener are composed by the
  launcher. The listener starts as part of transport startup and stops as part
  of transport shutdown.
- The PostgreSQL pool is closed only after bootstrap confirms successful
  shutdown. If containment/cleanup fails, the pool is deliberately retained
  so live handlers are not disconnected from their backing database.
- SIGINT/SIGTERM request graceful shutdown. An incomplete shutdown leaves a
  non-zero process exit status and emits a generic diagnostic.
- This launcher is an integration seam, not evidence of a production
  deployment. No real adapter, credentials, TLS issuance, storage backend,
  network topology, or database migration is supplied by this repository.

## Durable authorization for trusted bootstrap peers

A peer on `trustedPeerIds` may complete the handshake without an invitation,
but the allowlist is not a permanent revocation bypass. In official mode, every
authenticated application-frame dispatch is fenced by the PostgreSQL admission
store. An allowlisted peer with no admission row is permitted; a durable
`revoked` or `released` row overrides the allowlist and blocks dispatch.
Peers admitted through invitations require an `active` row.

The frame fence holds a shared transaction advisory lock through application
dispatch. Revocation and release take the matching exclusive lock before
changing the durable status. This serializes in-flight dispatch with both
transitions. PostgreSQL errors and ambiguous admission state fail closed.
`LISTEN/NOTIFY` remains an acceleration path for promptly closing sockets;
it is not the authorization source and is not relied on to enforce the next
application frame after a listener reconnect gap.

Revoking an allowlisted identity that has never had an admission row creates a
durable `revoked` tombstone in `peer_admissions`. The tombstone does not consume
active capacity or issuer quota, but it overrides the bootstrap allowlist after
process restart and prevents a later invitation admission from silently
re-enabling that identity. Removing such a ban requires an explicit, reviewed
administrative operation; do not delete tombstones as routine cleanup.
