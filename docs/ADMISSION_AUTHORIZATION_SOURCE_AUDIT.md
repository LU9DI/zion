# Admission and authorization source audit

Status: **source-level findings; no decentralized replacement is implemented**
Scope: PR #68, branch `architecture/fully-decentralized-core`
Audit basis: current branch source inspected on 2026-11-13.

## 1. Inspected source path

The official composition is:

`scripts/start-official-node.js`
→ `createPostgresPeerAdmissionRuntime`
→ `PostgresPeerAdmissionController`
→ `PostgresPeerAdmissionStore`
→ `PeerTransport`

The runtime also starts `PostgresPeerRevocationListener`. The official launcher requires `ZION_POSTGRES_URL` or `DATABASE_URL`, a PostgreSQL-compatible pool, a deployment-provided identity and integrity guard, a protocol genesis, and a non-empty static trusted-peer list. Remote transport currently requires mutual TLS material and an explicit trusted-peer allowlist.

The local `PeerAdmissionController` is not a distributed substitute: its queue serializes one process only, and its own comments explicitly disclaim cross-process serialization and durable revocation.

## 2. Existing invariants that must be preserved

### Admission

`PostgresPeerAdmissionStore.commitAdmission` uses a serializable transaction and a consistent lock order (subject, policy, capacity). It checks the persisted policy and capacity, issuer quotas, unique subject admission, and unique consumed invitation nonces; then writes the admission, issuer links, consumed nonces, and capacity increment in one transaction.

The controller also obtains capacity/headroom information before calling the store. That preflight is not authoritative: the store's transactional checks are what protect against concurrent admission races.

### Revocation and release

`revokeAdmission` takes the subject's exclusive advisory lock, then policy and capacity locks. It creates a durable revoked tombstone when no admission row exists, so a statically trusted bootstrap identity cannot reappear after restart. It decrements active capacity only when transitioning from active.

`releaseAdmission` also serializes against the subject dispatch fence and decrements capacity only for an active row. Terminal transitions are not interchangeable.

### Dispatch authorization

`withAdmissionFence` and `withPeerAuthorizationFence` hold a shared transaction advisory lock while the supplied callback executes. Revocation/release takes the matching exclusive lock. This gives a database-backed linearization rule, but it also holds a database connection and lock for the callback's full duration.

The distributed replacement must not imitate this with an unbounded distributed lock. It needs an explicit authorization point bound to committed project state, epoch, peer admission version, and the side-effect/commit boundary.

### Revocation notifications

PostgreSQL LISTEN/NOTIFY is an acceleration path only. The listener's own contract says reconnect gaps can occur; authoritative per-operation checks remain necessary. The replacement may gossip invalidation hints, but hints cannot become authority.

## 3. Concrete migration gaps

1. **No deterministic operation identity/result record:** `commitAdmission` accepts subject, issuer IDs, invitation nonces, headroom and limits, but no operation ID. The database uniqueness constraints prevent some duplicates, yet they do not provide a general queryable committed result for an ambiguous client retry.
2. **Unknown COMMIT is process-local:** the store sets an in-memory `commitOutcomeUnknown` flag after a connection failure once COMMIT has started. It fails closed for that store instance, but a restarted process does not inherit that flag. A distributed replacement must resolve ambiguity from replicated committed history using an operation ID and result digest, not a volatile latch.
3. **Capacity evidence needs deterministic provenance:** the current controller obtains capacity from an injected provider and passes a headroom ratio into the transaction. A peer-quorum design must define canonical evidence, units, freshness/epoch binding, and deterministic validation; local provider readings cannot independently authorize a global reservation.
4. **Static trust remains in the official path:** the launcher and transport require non-empty trusted peer IDs. These must eventually derive from committed genesis/governance epochs, with no permanent operator allowlist.
5. **Transport encryption/authentication remains transitional:** remote official transport currently requires mutual TLS and a CA bundle. A CA-free peer-key/Noise path is not yet integrated or proven.
6. **No committed-state authorization API exists:** current authorization reads PostgreSQL rows and holds transaction locks around callbacks. There is no storage-neutral API that distinguishes proposal, quorum commit, durable local apply, and operation result lookup.

## 4. Required storage-neutral boundary

A future interface must make states explicit rather than returning a single ambiguous `ok`:

- `getCommittedProjectState(projectId)`
- `getCommittedOperationResult(projectId, operationId)`
- `proposeAdmission(command, operationId)`
- `proposeRevocation(command, operationId)`
- `proposeRelease(command, operationId)`
- `authorizeOperation(peerId, projectId, requiredEpoch, admissionVersion, operation)`

Each command must have a canonical encoding and deterministic operation ID/result digest. The runtime must distinguish proposal accepted, quorum committed, locally persisted, and applied. A retry after a lost response must query/reconcile the same operation ID; it must never blindly create a second reservation or consume another invitation.

This is an interface target only. No JavaScript interface, BFT library, distributed lock, or replacement adapter is selected by this audit.

## 5. Safe next implementation order

1. Finish the BFT engine/protocol gate and validate project-scoped committee isolation.
2. Specify canonical admission/revocation/release commands, operation IDs, result records, and deterministic capacity evidence.
3. Build a storage-neutral deterministic state machine and property tests without touching the official launcher.
4. Test independent processes, concurrent admissions, nonce replay, capacity contention, revoke-vs-dispatch, lost responses, and restart recovery.
5. Only after a selected BFT engine can commit and recover this state, implement a peer-quorum adapter.
6. Switch official startup only after the adapter proves no database URL, PostgreSQL pool, CA, hosted scheduler, or mandatory seed is required.

## 6. Explicit non-claims

- This audit is not a code change to the admission runtime.
- It does not implement BFT, consensus certificates, distributed authorization, or a decentralized transport.
- It does not prove Sybil resistance, Byzantine safety, liveness, or production readiness.
- PostgreSQL, Neon, migrations, and the official launcher remain unchanged.
- No merge, deployment, release, or migration execution is authorized by this document.
