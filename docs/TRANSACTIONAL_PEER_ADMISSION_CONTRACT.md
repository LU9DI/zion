# Transactional peer-admission backend contract

Status: initial PostgreSQL store, real-PostgreSQL CI integration, independent-process capacity-race test, and `TransactionalPeerAdmissionController` adapter are implemented. **This is not yet production-ready**: deployment migration/rollback, restart reconciliation after ambiguous commits, broader independent-process race tests, operational recovery, and security review remain open.

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

The executable schema is committed at `migrations/postgres/0001_peer_admission.sql`. `src/peer-admission-postgres-store.js` provides a transaction-bound persistence API for a node-postgres-compatible pool, and `src/transactional-peer-admission-controller.js` verifies signed introduction vouchers before delegating uniqueness, issuer quotas, and capacity reservation to that store. The controller exposes asynchronous authoritative state queries and release operations. CI applies the migration to PostgreSQL 16 and tests concurrent admissions from independent Node.js processes. The migration is not automatically applied by the application; deployment must explicitly apply and verify it. The SQL below remains a conceptual reference; runtime identifiers/values must be safely handled and values parameterized.

```sql
CREATE TABLE peer_admission_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_active_peers integer NOT NULL CHECK (max_active_peers > 0),
  active_reservations integer NOT NULL DEFAULT 0
    CHECK (active_reservations >= 0 AND active_reservations <= max_active_peers),
  storage_headroom_ratio double precision NOT NULL
    CHECK (storage_headroom_ratio >= 0 AND storage_headroom_ratio <= 1),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0)
);

CREATE TABLE peer_admissions (
  subject_node_id char(64) PRIMARY KEY,
  issuer_node_ids char(64)[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  policy_version bigint NOT NULL CHECK (policy_version > 0)
);

CREATE TABLE consumed_peer_invitations (
  issuer_node_id char(64) NOT NULL,
  nonce varchar(65) NOT NULL,
  subject_node_id char(64) NOT NULL REFERENCES peer_admissions(subject_node_id)
    DEFERRABLE INITIALLY DEFERRED,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_node_id, nonce)
);

CREATE INDEX peer_admissions_issuer_node_ids_gin
  ON peer_admissions USING gin (issuer_node_ids);
```

Important: the schema is illustrative. The implementation must validate identifier and nonce encodings, cap array sizes, prevent duplicate issuer IDs in a row, and use normalized issuer-admission rows (with a unique key on `subject_node_id, issuer_node_id`) if quota queries rely on issuer membership. The array-based reference above is not sufficient by itself to enforce issuer quotas.

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

A concrete adapter is not ready until integration tests with a real database demonstrate:

- Two independent processes racing the same nonce: exactly one transaction commits.
- Two processes racing the same subject: exactly one admission exists.
- Concurrent admissions cannot exceed any issuer's quota.
- Concurrent admissions cannot exceed capacity reservations.
- Rollback leaves no consumed nonce, membership row, or capacity reservation behind.
- Simulated connection loss during commit is treated as ambiguous; the client re-reads authoritative state before retrying.
- Database restart preserves admission, nonce, quota, and capacity invariants.
- Serialization/deadlock retries are bounded and rerun the complete transaction.
- Tests use independent database connections/processes, not only concurrent promises in one Node process.

## Rollout and security constraints

- Keep `FilePeerAdmissionStateStore` explicitly single-process and suitable only for local/test deployments.
- Do not enable a distributed deployment until the transactional adapter, migrations, operational backups, restore/reconciliation, monitoring, and multi-process tests are merged.
- Database uniqueness protects against concurrent duplicate writes, not malicious administrators or rollback of restored backups. Backup rollback requires a separate monotonic epoch/checkpoint or external witness design.
- A database transaction cannot atomically reserve real physical storage on remote peers. Distributed storage capacity must use leases/reservations with expiry and reconciliation, not a snapshot number alone.
- The admission database is security-sensitive metadata. Apply least-privilege credentials, TLS, access controls, bounded queries, retention rules, and audit logging without logging invitation secrets.

## Acceptance gate

The schema and initial store are not a production-ready integrated backend. The controller still uses its existing stateStore API, and the new store has only fake-pool unit coverage. Before production use, wire the transactional controller into the actual network admission path, prove races for duplicate nonce/subject and issuer quotas across independent processes, test ambiguous commits and restart/reconciliation, validate migration/rollback and backup restore operations, and complete an independent security review. The existing `PeerAdmissionController` plus file state store remains single-process only; the transactional controller is a separate adapter and must be deliberately selected by the application. Zion remains not production-ready.
