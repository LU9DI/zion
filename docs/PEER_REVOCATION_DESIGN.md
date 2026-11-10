# Peer revocation design

## Status

Design proposal only. This document does not implement revocation and must not be treated as an operational revocation mechanism.

## Current behavior and security gap

The admission controller persists consumed introduction vouchers and admitted peer identities. Its state is coordinated by a single-process promise queue. The file-backed store uses atomic replacement and a checksum, but explicitly does not provide cross-process transactions. The transport caches admitted identities while at least one session for that identity remains connected.

There is currently no controller API to revoke an admitted identity, no durable revocation record, and no transport API that atomically closes every active session for a peer. Removing an identity from an in-memory cache alone would therefore be insufficient: a persisted admission could be read again, an already-authenticated socket could continue sending, or another process could retain stale state.

## Required security properties

A future implementation must satisfy all of the following:

1. **Durable deny decision:** revocation is persisted before the operation reports success. A persistence error puts the controller into its existing fail-closed unavailable state.
2. **No silent re-admission:** a revoked node ID cannot be re-admitted by presenting fresh or previously issued vouchers. Reinstatement, if ever supported, must be a separate explicit administrative operation with an auditable transition.
3. **Session termination:** every active socket authenticated as the revoked node is destroyed, including multiple simultaneous sessions.
4. **Receive-side enforcement:** after revocation commits, no application frame from that identity may reach `onMessage`. Closing sockets is the primary mechanism; a receive-side authorization check must cover queued frames and races with revocation.
5. **Race serialization:** admission, revocation, and persistence must share one serialization boundary. A handshake racing revocation must resolve to exactly one outcome: either admission completes before revocation and the session is then terminated, or revocation wins and admission is rejected.
6. **Restart safety:** revoked identities remain denied after process restart and state-store reload.
7. **Bounded state:** revocation records have explicit cardinality and byte limits. Capacity exhaustion fails closed; it must not silently discard older revocations.
8. **No false distributed guarantee:** the current file store and in-memory queue are single-process only. Multi-process deployments require a transactional shared store with uniqueness/serialization guarantees and a consistent revocation read path.

## State format and migration

Do not add a `revoked` array to version 1 and silently accept it. Introduce an explicit state schema version and a migration that:

- preserves every consumed voucher key;
- preserves every admitted subject and issuer list;
- initializes the revocation set as empty for legacy version 1 snapshots;
- validates uniqueness, ID format, record count, and total serialized size;
- writes the migrated snapshot atomically before the controller becomes available.

A failed migration must prevent the admission controller from serving requests.

## Proposed API boundary

The controller should expose a serialized `revoke(subjectNodeId, metadata)` operation and an authoritative `isRevoked(subjectNodeId)` query. Metadata should be bounded and non-secret (for example, reason code and timestamp); do not store arbitrary operator-supplied text without limits.

The transport should expose an explicit `revokePeer(subjectNodeId)` operation that first commits controller revocation, then destroys all matching sockets and clears only the corresponding ephemeral cache entries. It must not report success if durable revocation failed.

Avoid automatic un-revocation or deletion of consumed vouchers. A future reinstatement path requires separate authorization and audit semantics.

## Required tests before implementation is considered complete

- valid revocation persists and survives constructing a new controller from the same store;
- malformed IDs and duplicate revocations are deterministic and do not corrupt state;
- persistence failure rejects revocation and makes subsequent admission checks fail closed;
- admission and revocation racing on the same identity are serialized;
- two or more active sockets for one identity are all terminated;
- a frame queued before revocation cannot reach the application handler after revocation commits;
- a handshake racing revocation cannot leave an authenticated session alive;
- a revoked identity with fresh valid vouchers is rejected and does not consume replay-cache capacity;
- revocation-state capacity exhaustion fails closed;
- schema migration preserves voucher consumption and prior admissions;
- multi-process behavior is tested against the actual shared transactional store before being claimed as supported.

## Rollout constraints

Keep revocation behind an explicit API until the persistent schema, transport lifecycle, and concurrency tests are complete. Do not advertise this feature as available based on cache eviction or socket closure alone. Do not merge or deploy this design document as if it were an implementation.
