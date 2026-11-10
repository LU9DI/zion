# Transactional peer-admission backend contract

Status (2026-11-10): the PostgreSQL schema, transactional store, PostgreSQL-backed admission controller, dedicated revocation listener, per-frame distributed dispatch fence, and runtime composition helper are implemented. The current PR head has passed the full validation workflow, including real PostgreSQL 16 integration tests with independent Node.js processes, and CodeQL analysis for Rust and JavaScript/TypeScript. Coverage includes capacity, issuer quota, duplicate nonce/subject races, release accounting, dispatch-versus-revocation ordering, and listener lifecycle races. **This is not yet a production rollout: deployment-specific configuration, migration/backup operations, and restart reconciliation remain operator responsibilities and have not been certified.**

## Why the file store is insufficient

`PeerAdmissionController` with `FilePeerAdmissionStateStore` serializes operations only inside one JavaScript process. Two processes can both load the same snapshot, validate the same invitation nonces, pass issuer quotas and capacity checks, then overwrite one another's snapshots. Atomic rename and a checksum do not make the read/validate/write sequence transactional.

Do not run multiple admission coordinators against the file-backed store, a shared filesystem snapshot, or a generic key-value store without a proven transaction primitive. The file-backed controller's compatibility fence is local-only and does not provide persistent or cross-process revocation.

## PostgreSQL implementation

The executable schema is `migrations/postgres/0001_peer_admission.sql`. It defines normalized issuer membership, unique invitation consumption, policy and capacity singleton rows, and constrained admission states.

The implementation is split across:

- `src/peer-admission-postgres-store.js`: injected node-postgres-compatible pool, transactional admission, authoritative status, shared/exclusive advisory-lock dispatch fence, revocation and administrative release.
- `src/peer-admission-postgres-controller.js`: trusted-voucher verification and controller facade over the store.
- `src/peer-admission-postgres-listener.js`: dedicated `LISTEN` connection with bounded reconnect and strict notification payload validation.
- `src/postgres-peer-admission-runtime.js`: composes store, controller, listener, and official `PeerTransport` from deployment-supplied dependencies.

Example composition:

```js
const runtime = createPostgresPeerAdmissionRuntime({
  pool, // caller-owned node-postgres-compatible pool
  controllerOptions: {
    trustedIssuerNodeIds,
    capacityProvider, // authoritative deployment adapter
  },
  transportOptions: {
    identity,
    integrityGuard,
    protocolGenesis,
    trustedPeerIds,
    onMessage,
    // host, port, TLS, limits, and transfer scheduler as required
  },
});

// Give this exact transport to OfficialNodeBootstrap.
const bootstrap = new OfficialNodeBootstrap({
  integrityGuard,
  transport: runtime.transport,
  startStorage,
  stopStorage,
});
```

The factory deliberately does not create a pool, load secrets, apply migrations, choose trusted issuers, or invent a storage-capacity provider. The caller owns pool lifecycle and passes the same pool to the store and listener. Do not pass separate admission adapters in `transportOptions`; the factory rejects those overrides.

## Transaction and dispatch guarantees

Admission writes use serializable transactions, singleton policy/capacity row locks, normalized issuer-quota checks, uniqueness constraints, and bounded retries of the entire transaction for serialization/deadlock errors. A commit failure after COMMIT begins is treated as ambiguous: the store latches admission operations closed for that process and requires authoritative reconciliation rather than blindly replaying a potentially committed write.

For application dispatch, `withAdmissionFence(subjectNodeId, work)` obtains a transaction-scoped shared advisory lock, reads durable admission status, and holds the connection and lock through the bounded application callback. Revocation and administrative release take the matching exclusive advisory lock before changing status. This linearizes each admission-controlled frame against every transition out of active status across processes.

Notifications are sent transactionally and delivered only after commit. They are an acceleration path for closing local sessions, not the authorization boundary: each subsequent frame still checks durable status under the shared fence. The listener uses a dedicated pool connection, so pool sizing must account for that reserved connection plus concurrent in-flight frame handlers.

The dispatch callback executes while a database transaction, connection, and lock are held. It must be bounded and must not wait on unrelated long-running work. Do not use a timeout wrapper that releases the transaction while the callback continues.

The guarantee applies to admission-controlled sessions. Peers independently trusted by the explicit bootstrap allowlist remain governed by that allowlist.

## External capacity and policy inputs

Voucher signatures, subject binding, issuer trust, expiry, nonce syntax, and distinct issuer identities are checked before admission persistence. Mutable database facts (subject uniqueness, consumed nonces, issuer quota, and reserved peer capacity) are checked transactionally.

The controller's `capacityProvider` supplies active-peer count, max-peer limit, and storage headroom. These values are external to the PostgreSQL transaction unless the deployment explicitly sources/version-controls them in the same database. A production deployment must define their freshness bound, fail closed when unavailable, and avoid treating a stale physical-storage snapshot as a durable reservation. Real distributed storage capacity requires leases/reservations with expiry and reconciliation.

## Required operational gates before production

- Apply and verify migration `0001_peer_admission.sql` through a reviewed deployment migration process. Runtime startup does not apply migrations automatically.
- Provision the PostgreSQL pool with TLS, least-privilege credentials, bounded connection counts/timeouts, monitoring, and backup/restore procedures. Size it for the dedicated listener connection and dispatch transactions held through callbacks.
- Supply trusted issuer IDs, genesis, bootstrap allowlist, identity, mutual-TLS material for non-loopback transport, and an authoritative capacity provider through deployment-owned configuration.
- Construct the runtime with `createPostgresPeerAdmissionRuntime` and pass its exact `transport` to `OfficialNodeBootstrap`. Confirm that the production entrypoint actually uses this composition; component tests alone do not prove deployment wiring.
- Define restart reconciliation for ambiguous commits and capacity counters. The current in-process fail-closed latch does not survive restart and is not a durable reconciliation protocol.
- Exercise database restart, backup restore, migration upgrade/rollback, and counter reconciliation against realistic operational data.
- Keep the file-backed controller single-process only.
- Protect admission metadata and audit logs; never log invitation secrets or bearer material.

## Acceptance gate

The component-level PostgreSQL path, concurrency tests, runtime-composition tests, and listener lifecycle race tests have passed CI at the current PR head. CodeQL has also passed for Rust and JavaScript/TypeScript. Production readiness additionally requires the deployment to wire the helper into the official bootstrap, apply and rehearse migrations, validate capacity-provider freshness, and implement durable restart reconciliation and backup/restore procedures. Until those gates are demonstrated, do not describe Zion's distributed peer admission as production-ready.
