# Peer revocation design

## Status

Design proposal only. This document does not implement transport-level revocation and must not be treated as an operational revocation mechanism.

## Existing mechanisms and actual gap

The repository already contains part of the durable revocation primitive in the PostgreSQL model:

- `migrations/postgres/0001_peer_admission.sql` defines `peer_admissions.status` with `active`, `released`, and `revoked`.
- `PostgresPeerAdmissionStore.releaseAdmission(subjectNodeId, 'revoked')` changes an active row to `revoked` transactionally and decrements active capacity exactly once.
- `commitAdmission()` inserts by the subject primary key, so an existing revoked row cannot be silently re-admitted under the same identity.
- The PostgreSQL store is not wired into `PeerAdmissionController`, and there is no authoritative status/read API exposed to the transport.
- The file-backed controller persists only version-1 `consumed` and `admissions` arrays and has no revocation state or revocation method.
- The transport has no public revocation operation that closes every active session for a node ID or fences in-flight frames/handshakes.

Therefore, do not create a parallel PostgreSQL revocation table without a demonstrated need. The existing status column is the preferred durable source of truth for the PostgreSQL adapter. File-store support requires an explicit, backward-compatible state-version migration (or a separately justified tombstone design), not silently extending version 1.

## Required security properties

1. **Durable deny decision:** persist the revoked status before reporting success. If the commit outcome is ambiguous, fail closed and reconcile authoritative state before allowing new admissions.
2. **No silent re-admission:** a revoked node ID cannot be admitted with fresh or previously issued vouchers. Reinstatement, if ever supported, must be a separate explicit administrative operation with auditable authorization.
3. **Capacity accounting:** transition from active to revoked decrements active reservations exactly once; repeated revocation is idempotent and must not decrement again. A released row must not be confused with a security revocation.
4. **Session termination:** every active socket authenticated as the revoked node is destroyed, including multiple simultaneous sessions.
5. **Receive-side enforcement:** after revocation commits, no application frame from that identity may reach `onMessage`. Closing sockets is primary; a receive-side authorization/fencing check must cover queued frames and races.
6. **Race serialization:** admission and revocation for the same subject share an authoritative serialization boundary. A racing handshake must not become usable after revocation commits.
7. **Restart safety:** revoked identities remain denied after process restart and authoritative store reload.
8. **Bounded state:** file-store migration must enforce record and byte limits. Exhaustion fails closed; it must not discard old revocations.
9. **No false distributed guarantee:** the file store and process-local Promise queue are single-process only. Multi-process operation requires the PostgreSQL transactional store (or equivalent) to be integrated and queried consistently.

## Required API boundary

The PostgreSQL adapter should expose an explicit `revokeAdmission(subjectNodeId)` operation (or a narrowly scoped wrapper over `releaseAdmission(subjectNodeId, 'revoked')`) and an authoritative `getAdmissionStatus(subjectNodeId)` query. Both must validate identifiers, handle missing rows deterministically, and treat ambiguous commit outcomes as unavailable. A status query must not treat `released` as `revoked`.

The file-backed controller needs an explicit versioned state migration that preserves consumed vouchers and admissions while adding durable revocation tombstones. Its queue must serialize admission and revocation. On save failure, retain the existing fail-closed behavior because the write may have committed despite an error.

The transport should expose `revokePeer(subjectNodeId)`: commit durable revocation first, then destroy every matching active socket, invalidate the peer's ephemeral cache, and fence any in-flight handshake or frame dispatch. It must not report success if persistence failed. Do not expose a remote unauthenticated protocol message that lets any peer revoke another peer.

## Required tests before implementation is complete

- PostgreSQL: active-to-revoked transition commits; duplicate revocation is idempotent; capacity decrements once; released is distinct from revoked.
- PostgreSQL: revoked subject cannot be re-admitted with fresh valid vouchers; consumed voucher uniqueness remains intact.
- PostgreSQL: ambiguous commit fails closed and status is reconciled from the authoritative database after reconnect/restart.
- File store: version-1 snapshots migrate without losing consumed voucher keys or admissions; revoked tombstones survive restart.
- File store: malformed IDs, duplicate tombstones, size limits, and persistence failure fail closed.
- Controller: admission and revocation racing for one identity serialize deterministically.
- Transport: all simultaneous sessions for the identity are destroyed.
- Transport: a queued frame and an in-flight handshake cannot reach application handling or remain authenticated after revocation commits.
- Transport: a revoked peer with fresh valid vouchers is rejected before replay-cache insertion.
- Multi-process behavior is tested against the actual shared transactional store before being claimed as supported.

## Rollout constraints

Keep revocation behind an explicit administrative API until the persistent state, transport lifecycle, and concurrency tests are complete. Do not advertise the existing PostgreSQL status column as a complete revocation feature: it currently covers durable status and capacity accounting only, not controller integration or live-session termination. Do not merge or deploy this design document as if it were an implementation.
