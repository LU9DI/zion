# Transactional peer-admission backend contract

Status (2026-10-10): PostgreSQL schema migration, initial injected-pool transaction store, CI PostgreSQL 16 service, and real-database integration tests using independent Node.js processes are committed. The integration test covers capacity serialization, release accounting, duplicate invitation nonce races, duplicate subject races, and issuer quota races. The workflow is configured to run these checks, but a successful run for the latest test commit must be confirmed before treating the test suite as green. **The store is still not wired into `PeerAdmissionController`; production rollout, restart reconciliation, and operational migration/restore remain incomplete.**

## Why the file store is insufficient

`PeerAdmissionController` currently serializes operations with a Promise queue and commits a local snapshot. That queue exists only inside one JavaScript process. Two processes can both load the same snapshot, validate the same invitation nonces, pass issuer quotas and capacity checks, then overwrite one another's snapshots. Atomic rename and a checksum do not make the read/validate/write sequence transactional. A failed save also has an ambiguous outcome; the controller now fails closed for the remainder of that process.

Do not run multiple admission coordinators against `FilePeerAdmissionStateStore`, a shared filesystem snapshot, or a generic key-value store without a proven transaction primitive.

## Required adapter boundary

A production adapter must expose an operation equivalent to:

```ts
withAdmissionTransaction<T>(
  work: (tx: AdmissionTransaction) => Promise<T>
): Promise<T>
```

The callback must run against one database transaction, with commit/rollback owned by the adapter. The transaction interface must support:

- Reading and locking the authoritative admission policy/capacity row(s).
- Checking whether a subject has already been admitted.
- Atomically consuming a set of invitation keys.
- Enforcing per-issuer admission quotas.
- Reserving one unit of peer capacity.
- Writing the admission record and consumption records.
- Returning success only after the database confirms commit.

The callback must not perform network calls or unbounded work while holding locks. Cryptographic voucher verification and syntactic validation should happen before opening the transaction; all mutable facts (nonce uniqueness, subject uniqueness, issuer quota, rollout/capacity reservation) must be rechecked inside it.

A generic `load()` + `save()` pair is not a substitute for this interface. Neither a process-local mutex nor a transaction around only the final write is sufficient.

## PostgreSQL reference model

The executable schema draft is committed at `migrations/postgres/0001_peer_admission.sql`. `src/peer-admission-postgres-store.js` provides an initial transaction-bound persistence API for a node-postgres-compatible injected pool, with serializable transactions, singleton-row locks, uniqueness handling, issuer-quota checks, capacity reservation, bounded serialization/deadlock retries, and release/revoke operations. Fake-pool unit tests cover transaction boundaries and rollback behavior. The real PostgreSQL 16 integration test applies the migration and starts independent Node.js processes, each with its own pool, to race admission attempts. It covers one-slot capacity, the same invitation nonces across different subjects, the same subject with different invitations, issuer quota one, and release/capacity accounting. The migration is applied by the integration test, not automatically by the runtime. **This test coverage does not mean the latest workflow run has passed, and the store is not yet integrated into `PeerAdmissionController`.**

Important: the schema and implementation are an initial adapter, not a production-ready admission system. The implementation must validate identifier and nonce encodings, cap array sizes, prevent duplicate issuer IDs in a row, and use normalized issuer-admission rows (with a unique key on `subject_node_id, issuer_node_id`) if quota queries rely on issuer membership. The current migration does use normalized issuer rows. Trusted issuer configuration and cryptographic voucher verification remain caller responsibilities.

## Required transaction algorithm

Use a real serializable transaction or a carefully reviewed locking strategy that provides equivalent guarantees. Handle serialization failures by retrying the entire bounded transaction with a finite retry limit; never retry only the final insert.

1. Validate voucher signatures, subject binding, issuer trust, expiry, nonce syntax, and distinct issuer identities before entering the transaction.
2. Begin a transaction and lock the singleton capacity/policy row (or use a proven atomic capacity reservation).
3. Re-read current policy, rollout stage, active reservations, and storage headroom from authoritative sources. If those facts are external and cannot be locked or versioned, explicitly define the stale-data bound and fail closed when unavailable.
4. Check the subject does not already exist.
5. Check each `(issuer_node_id, nonce)` is unconsumed. Database uniqueness remains the final arbiter under races.
6. Check issuer quotas using normalized issuer-membership rows inside the same transaction.
7. Reserve capacity atomically, subject to the configured cap and policy version.
8. Insert the admission, issuer-membership rows, and consumed invitation rows in the same transaction.
9. Commit. Only then report success or let transport accept the peer.
10. On any constraint conflict, serialization failure beyond retry limit, unavailable capacity state, or ambiguous commit, return a typed failure and reconcile authoritative state before allowing further admissions.

## Required concurrency and failure tests

The real PostgreSQL integration test now exercises independent processes and checks persisted state for:
- Two independent processes racing the same nonce: exactly one transaction commits.
- Two processes racing the same subject: exactly one admission exists.
- Concurrent admissions cannot exceed an issuer's quota of one.
- Concurrent admissions cannot exceed a one-peer capacity reservation.
- Release decrements active reservations and removes the peer from the active set.

Additional gates remain:
- Rollback leaves no consumed nonce, membership row, or capacity reservation behind.
- Simulated connection loss during commit is treated as ambiguous; the client re-reads authoritative state before retrying. (Fail-closed latch exists, but durable restart reconciliation is outstanding.)
- Database restart preserves admission, nonce, quota, and capacity invariants.
- Serialization/deadlock retries are bounded and rerun the complete transaction.
- Repeated migration/upgrade/rollback and backup-restore behavior is validated against realistic operational data.

## Rollout and security constraints

- Keep `FilePeerAdmissionStateStore` explicitly single-process and suitable only for local/test deployments.
- Do not enable a distributed deployment until the transactional adapter is integrated, migrations and operational backups are validated, restart reconciliation exists, and the multi-process tests pass in CI.
- Database uniqueness protects against concurrent duplicate writes, not malicious administrators or rollback of restored backups. Backup rollback requires a separate monotonic epoch/checkpoint or external witness design.
- A database transaction cannot atomically reserve real physical storage on remote peers. Distributed storage capacity must use leases/reservations with expiry and reconciliation, not a snapshot number alone.
- The admission database is security-sensitive metadata. Apply least-privilege credentials, TLS, access controls, bounded queries, retention rules, and audit logging without logging invitation secrets.

## Acceptance gate

The schema and initial store are not a production-ready integrated backend. The controller still uses its existing `stateStore` API, and the PostgreSQL store has fake-pool unit coverage plus newly added real-database multi-process tests. Before production use, wire cryptographically verified vouchers to this transaction boundary, confirm CI results, test ambiguous commits and restart/reconciliation, and validate migration/rollback operations. Until those gates pass, the controller's documented guarantee remains single-process only, and Zion remains not production-ready.
