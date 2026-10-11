# Official PostgreSQL admission deployment and recovery runbook

This runbook is an execution gate, not evidence that a production environment has already been exercised. Run every destructive drill only against an isolated disposable deployment and test database.

## Repository wiring audit

The repository audit at commit `e6c13486f22898b9dafcbd297b3b83cf91bbdd07` found a composition boundary, but no official-node executable entry point:

- `package.json` exposes local test/demo and cloud-preview scripts, but no official-node start/deploy script.
- `src/official-postgres-admission-transport.js` composes PostgreSQL admission, the verified admission service, and the official peer transport.
- `src/official-node-bootstrap.js` validates and orchestrates a supplied transport and storage adapters; it does not construct production identity, trust roots, PostgreSQL pool, storage adapter, or capacity provider.
- `cloud/README.md` identifies the cloud UI as a static local preview, not a connected cloud service.

Therefore, the factory is **not yet wired into a real deployment launcher**. Do not interpret unit tests, the CI PostgreSQL integration test, or this runbook as proof that an official node can be deployed. The next integration step requires a real launcher and deployment-owned configuration for identity/key material, database lifecycle and migrations, reviewed genesis, bootstrap peers, trusted voucher issuers, storage adapter, and capacity/headroom measurements. Do not add placeholder values or silently fall back to in-memory admission to make startup appear successful.

## 1. Preflight — do not open the listener yet

- [ ] Pin the release commit and record its SHA in the change record.
- [ ] Provision PostgreSQL using deployment-managed credentials and least-privilege roles. Do not place credentials in source control or logs.
- [ ] Verify the target database identity and connectivity from the same runtime that will host the node.
- [ ] Apply `migrations/postgres/0001_peer_admission.sql` using the deployment migration process; verify the resulting schema before startup.
- [ ] Provision the reviewed protocol genesis, bootstrap peer allowlist, and trusted issuer node IDs through a trusted configuration channel.
- [ ] Confirm trusted issuer IDs are unique and sufficient for the configured threshold.
- [ ] Supply a storage-headroom provider that fails closed when measurements are missing, stale, invalid, or unavailable.
- [ ] Construct the official transport with `createOfficialPostgresAdmissionTransport()` and pass that exact transport and its exact `IntegrityGuard` instance to `OfficialNodeBootstrap`.
- [ ] Confirm no other official-mode path can instantiate a transport with an in-memory or absent admission controller.
- [ ] Keep external traffic blocked until the checks below pass.

## 2. Admission correctness checks

Use a disposable database and unique test identities/nonces for every run.

- [ ] Valid, distinct, trusted issuer vouchers admit the intended subject.
- [ ] Invalid signatures, expired vouchers, wrong subjects, untrusted issuers, duplicate issuers, and reused nonces are rejected.
- [ ] Concurrent admissions cannot exceed global capacity or an issuer's quota.
- [ ] Releasing an admission updates authoritative state, and `isAdmitted()` reflects that state.
- [ ] Capacity-provider exceptions, NaN, infinities, and values outside [0, 1] fail closed.
- [ ] An ambiguous COMMIT never triggers automatic replay. Reconcile by querying authoritative state before any retry.
- [ ] One subject's ambiguous COMMIT does not unnecessarily block unrelated subjects.

Record test IDs, timestamps, commit SHA, database version, expected result, observed result, and sanitized logs. Never record invitation secrets or database credentials.

## 3. Failure and recovery drills

Only run against a disposable environment with snapshots and an explicit cleanup plan.

### PostgreSQL restart
1. Admit a test subject and verify it is active.
2. Restart PostgreSQL using the same supported deployment mechanism used operationally.
3. Reconnect and verify the admission row and consumed nonces remain consistent.
4. Confirm the node does not accept new admissions while database health is unavailable.

### Crash around COMMIT
1. Instrument a test-only fault boundary around transaction commit; do not add a production backdoor.
2. Exercise failure before COMMIT and confirm no partial admission or nonce consumption remains.
3. Exercise a client-side connection loss after COMMIT may have succeeded.
4. Restart the process and query authoritative database state before retrying; verify no duplicate admission or nonce reuse occurs.
5. Capture the database state and sanitized evidence for each outcome.

### Backup and restore
1. Create an application-consistent database backup using the intended production method.
2. Restore into an isolated database and verify schema version, active admissions, issuer quotas, and nonce uniqueness.
3. Verify that restored state cannot be mistaken for a newer live database. Define a restore/fencing procedure before routing traffic to it.
4. Document RPO/RTO observed; do not claim values until measured.

### Migration rollback and recovery
1. Test migration on a disposable database snapshot and inspect schema/data changes.
2. If the migration is not safely reversible, verify the documented forward-fix or restore procedure instead of improvising a destructive rollback.
3. Restore the pre-migration snapshot, rerun the supported migration path, and rerun admission checks.
4. Confirm application startup refuses incompatible or missing schema rather than silently opening the listener.

## 4. Go/no-go criteria

Do not enable an official deployment until all are true:

- [ ] A real official-node launcher wires the factory and bootstrap together and its configuration is reviewed.
- [ ] All admission correctness and failure drills above have recorded passing evidence.
- [ ] Backup restore and migration recovery have been demonstrated by someone other than the implementer where feasible.
- [ ] Database credentials, genesis, allowlists, and issuer trust are provisioned outside the repository.
- [ ] Monitoring and operator procedures exist for database outage, capacity-provider failure, ambiguous COMMIT, stale active rows, and restore/fencing.
- [ ] The exact release commit has passing CI and security checks.
- [ ] A rollback/disable plan exists that does not silently switch official mode back to in-memory admission.

## 5. Evidence template

For each drill, record:

- Date/time (UTC):
- Operator/reviewer:
- Release commit:
- PostgreSQL version and isolated environment:
- Scenario and fault injection point:
- Expected result:
- Observed result:
- Database invariants checked:
- Sanitized log or CI run URL:
- Pass/fail and follow-up issue:

Until this evidence is recorded, the release remains **not production-certified**.
