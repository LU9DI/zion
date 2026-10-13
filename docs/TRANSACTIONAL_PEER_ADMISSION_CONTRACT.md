# Transactional peer-admission backend contract

Status (2026-10-13): the repository now contains a PostgreSQL-backed admission store, a voucher-verifying admission service, an official transport composition boundary, a migration runner, an official-node launcher, and real PostgreSQL multi-process integration tests. Exact-head CI and CodeQL passed for commit `23fa488e2dd1a9baf3a73ee10972eccfec5193d2`:
- [Zion validation](https://github.com/LU9DI/zion/actions/runs/38459915947)
- [CodeQL security analysis](https://github.com/LU9DI/zion/actions/runs/38459916108)

These are repository-level automated checks, not production certification. PR #33 remains a draft because a deployment-owned adapter/trust configuration and operational recovery evidence are not part of this repository change.

## Architecture and boundaries

- `src/peer-admission-postgres-store.js` implements transaction-bound persistence against a node-postgres-compatible pool. It serializes mutable admission invariants in PostgreSQL, applies bounded retries for serialization/deadlock errors, and treats uncertain transaction outcomes conservatively.
- `src/verified-postgres-peer-admission-service.js` validates voucher shape and cryptographic validity against the configured trusted issuer set before delegating admission to the store. It also exposes persistent-state verification, authoritative admission reads, and release operations.
- `src/official-postgres-admission-transport.js` composes the verified service with the official peer transport. The official transport must use this boundary rather than pass caller-provided issuer IDs/nonces directly to the raw store.
- `scripts/start-official-node.js` wires the composition through `OfficialNodeBootstrap` using an absolute, deployment-owned adapter module. The adapter must provide identity, reviewed genesis and trust lists, a complete `IntegrityGuard`, storage lifecycle hooks, and a trustworthy storage-headroom provider.
- `scripts/migrate-postgres.js` applies checksum-tracked migrations under a PostgreSQL session advisory lock. Migrations are a controlled release operation and are intentionally not silently applied at node startup.

The legacy `PeerAdmissionController` / `FilePeerAdmissionStateStore` path remains process-local. Do not treat its snapshot store as a distributed admission coordinator. Distributed deployments must use the official verified PostgreSQL composition and deployment-owned configuration.

## Required transaction invariants

The database transaction must recheck all mutable facts, regardless of any pre-transaction voucher verification:
- uniqueness of the admitted subject;
- one-time consumption of each `(issuer_node_id, nonce)`;
- per-issuer admission quotas;
- capacity reservation and active-admission accounting;
- durable admission and issuer-membership records.

The store uses database constraints and transactional serialization as the final arbiter for concurrent attempts. It must only report a committed admission after commit is confirmed. If COMMIT has an ambiguous outcome, rollback fails, an authoritative read fails, or startup-preflight transaction state cannot be confirmed, the questionable PostgreSQL session is discarded rather than returned to the pool. Such failures must fail closed; callers must not infer that an ambiguous admission did not commit.

Voucher signatures, subject binding, trusted issuer membership, expiry and nonce syntax are verified before the transaction. Storage headroom is provided by a deployment hook and is not itself locked by PostgreSQL. It therefore remains an external observation, not an atomic reservation of physical storage; deployments must define freshness, failure handling and reconciliation for that signal.

## Schema and migrations

The initial migration is `migrations/postgres/0001_peer_admission.sql`. Applied migrations are tracked by ID and SHA-256 checksum; editing an applied migration is rejected, and a new migration must be added for schema changes. The migration runner uses a session advisory lock and fails closed if acquisition or release cannot be confirmed. If the outcome of migration commit or lock cleanup is uncertain, operators must inspect the schema-migration ledger before retrying.

Run `npm run db:migrate` as a controlled deployment/release step with appropriately scoped credentials. Do not grant the runtime role schema-owner privileges merely for convenience. Provision TLS, least-privilege database roles, network restrictions, backups and audit policy separately.

## Automated validation

The integration suite uses PostgreSQL 16 and independent Node.js processes/pools to exercise races involving:
- the same invitation nonce;
- the same subject;
- a per-issuer quota;
- a one-peer capacity reservation;
- release and active-capacity accounting.

The test suite also covers transaction failure paths, bounded retry behavior, startup verification and launcher cleanup. Exact-head CI is linked above. Passing tests establish only the covered behaviors under the test setup; they do not prove behavior under every network partition, storage failure, operator action, or production topology.

## Remaining production gates

1. **Deployment adapter and trust:** supply and independently review the real adapter, identity/key custody, genesis, trusted peer and issuer lists, complete integrity guard, storage lifecycle and headroom telemetry. Test fixtures are not production trust material.
2. **Database operations:** provision production credentials/roles, TLS, monitoring, connection/pool limits, backup/restore, migration ownership, rollback strategy and restore fencing.
3. **Recovery drills:** execute and record PostgreSQL restart, crash/ambiguous-COMMIT, backup/restore, migration interruption/retry, and stale or uncertain state reconciliation against a disposable deployment.
4. **External capacity truth:** specify the freshness and authority of storage-headroom data, and prove behavior when that signal is stale, unavailable or inconsistent with actual storage.
5. **Operational security:** define alerting, incident response, key rotation, audit retention and a recovery procedure that does not silently reuse consumed invitations after restore.

Database uniqueness does not prevent a privileged operator from restoring an old backup and thereby rolling back security-sensitive state. Restore rollback requires independently maintained monotonic fencing/checkpoint evidence or an equivalent operational control.

## Acceptance gate

The transactional backend and official composition are implemented and covered by the current automated suite, but production readiness is not established. Keep PR #33 in draft and do not merge it as a production-readiness signal until the deployment-owned adapter/configuration and operational recovery gates above have been independently exercised and recorded.
