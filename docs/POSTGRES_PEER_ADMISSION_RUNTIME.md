# PostgreSQL peer-admission runtime integration

## Status and boundary

`createPostgresPeerAdmissionRuntime()` composes the PostgreSQL admission store, controller, dedicated revocation listener, and official-mode `PeerTransport`. It is an integration factory, not a deployable node executable.

At the current repository revision there is no production node entrypoint, deployment manifest, container definition, or start script that constructs an `OfficialNodeBootstrap` with this runtime. `src/demo.js` and `src/social-message-node.js` are not substitutes for the official P2P node entrypoint. Therefore, merging this feature does **not** by itself switch a running deployment to PostgreSQL-backed admission.

The host application must deliberately wire the runtime into its official startup path and supply real, deployment-owned identity, integrity, protocol-genesis, trust, TLS, capacity, storage, and message-processing adapters.

## Required host dependencies and database

The host must provide a node-postgres-compatible pool. The repository factory intentionally does not import or create `pg`, read credentials, or own the pool lifecycle. Install and pin a supported `pg` version in the host deployment and construct the pool there.

The database must be PostgreSQL with permission to use transaction-scoped advisory locks, row locks, and `LISTEN/NOTIFY`. Apply the peer-admission schema/migrations before starting the node. Use a dedicated database role with only the privileges needed by the admission tables and notification channel.

The listener holds one pool client for its dedicated `LISTEN` session. Admission-fenced message processing also checks out a client and holds its transaction/lock until the application callback finishes. Set pool capacity above one; size it for the listener plus peak concurrent fenced callbacks and other application queries. Bound message-handler work and database/statement/connection timeouts: a slow callback intentionally delays a concurrent revocation or release.

## Composition

The following is an integration shape, not a ready-made production configuration. Replace every placeholder with the host's verified adapters and reviewed configuration.

```js
import pg from 'pg';
import { createPostgresPeerAdmissionRuntime } from './src/postgres-peer-admission-runtime.js';
import { OfficialNodeBootstrap } from './src/official-node-bootstrap.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 12),
  // Configure TLS, connection/idle timeouts, and certificate verification
  // according to the deployment's database security policy.
});

const runtime = createPostgresPeerAdmissionRuntime({
  pool,
  storeOptions: {
    // Supply only reviewed PostgresPeerAdmissionStore options.
  },
  controllerOptions: {
    // Supply trusted issuer IDs and a real capacityProvider.
  },
  listenerOptions: {
    // Optional bounded reconnect settings.
  },
  transportOptions: {
    identity: verifiedNodeIdentity,
    host: configuredBindHost,
    port: configuredPort,
    networkMode: 'official',
    protocolGenesis: reviewedProtocolGenesis,
    integrityGuard,
    trustedPeerIds: reviewedBootstrapPeerIds,
    tlsOptions: verifiedMutualTlsOptions,
    onMessage: boundedAuthorizedMessageHandler,
    // Add only explicitly reviewed transport limits and adapters.
  },
});

const bootstrap = new OfficialNodeBootstrap({
  integrityGuard,
  transport: runtime.transport,
  startStorage,
  stopStorage,
  getStorageStatus,
  // Add the host's real schedulers/workers only when configured.
});

try {
  await bootstrap.start();
} catch (error) {
  // Startup rolls back its managed adapters. Do not accept traffic.
  await pool.end();
  throw error;
}

async function shutdown() {
  // First stop transport and its PostgreSQL LISTEN consumer; only then end pool.
  await bootstrap.close();
  await pool.end();
}
```

Do not pass an independently constructed admission controller or revocation listener to `transportOptions`; the factory owns both. Do not override the listener's pool. The factory returns a frozen object containing `store`, `admissionController`, `revocationListener`, and `transport`; it does not own or close the supplied pool.

## Authorization and consistency contract

- The PostgreSQL store's transaction-scoped shared advisory lock is the authoritative per-frame fence. It remains held while the transport invokes the application message callback.
- Revocation and release take the matching exclusive advisory lock. They wait for an in-flight fenced callback to finish, or win first and cause a later callback to observe an inactive admission.
- `LISTEN/NOTIFY` is a prompt local-session teardown mechanism only. Notifications can be missed during disconnect/reconnect; never treat them as the authorization boundary.
- Do not configure an official admission-controlled peer transport with the file-backed controller. Do not allow a missing database fence to fall back to local admission state.
- The bootstrap owns the transport/listener lifecycle. On normal shutdown, await `bootstrap.close()` before calling `pool.end()`. If shutdown fails, surface the failure and do not claim the node is cleanly stopped.

## Release gate

Before enabling this in a real deployment:

1. Add the host-specific composition to the actual official node entrypoint; do not treat this document or the factory test as deployment wiring.
2. Provision and migrate PostgreSQL, verify role permissions, TLS, backups, connection limits, and operational timeouts.
3. Verify that every admission-changing path uses the same PostgreSQL store and that no legacy/file-backed path can authorize official sessions.
4. Run integration tests against a real PostgreSQL instance, including concurrent dispatch versus revoke/release, listener disconnect/reconnect, missed notifications, process restart, pool exhaustion, and database outage.
5. Confirm startup fails closed when PostgreSQL is unavailable and shutdown drains transport/listener before closing the pool.
6. Validate the actual deployed artifact and configuration before enabling external peer traffic.

Passing unit tests and CI does not establish that a production node is wired, deployed, or safe for public-network operation.
