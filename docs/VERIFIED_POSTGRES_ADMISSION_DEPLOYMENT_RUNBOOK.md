# Official PostgreSQL admission deployment and recovery runbook

This runbook is an execution gate, not evidence that a production environment has already been exercised. Run every destructive drill only against an isolated disposable deployment and test database.

## Repository wiring audit

The initial repository audit at commit `e6c13486f22898b9dafcbd297b3b83cf91bbdd07` found a composition boundary but no executable entry point. Since then, `scripts/start-official-node.js` and `npm run start:official` have been added:

- `src/official-postgres-admission-transport.js` composes PostgreSQL admission, the verified admission service, and the official peer transport.
- `src/official-node-bootstrap.js` verifies release integrity and persistent admission state, then orchestrates storage/listener lifecycle.
- Startup rollback records lifecycle attempts before awaiting adapter startup and closes partially initialized notification APIs/schedulers if their `listen()` or `start()` call rejects. Scheduler shutdown drains in-flight inactivity evaluations before storage shutdown. Deployment adapters must still make `close()`/`stop()` safe after partial initialization and report cleanup failures rather than hiding them.
- `scripts/start-official-node.js` loads an absolute-path, deployment-owned adapter module, creates a bounded PostgreSQL pool, validates the adapter contract, wires the factory into `OfficialNodeBootstrap`, and closes the pool only after bootstrap cleanup succeeds. Shutdown closes notification ingress first, drains scheduler producers, then the delivery worker, transport, and storage. A failed shutdown remains retryable; the launcher deliberately keeps PostgreSQL available while transport/storage cleanup is unconfirmed rather than severing live handlers from their database. If startup cleanup cannot be confirmed, investigate remaining listeners/storage and clean them up before terminating the database pool. It deliberately does not run migrations automatically; migrations remain a controlled release operation.
- The deployment adapter must export `createOfficialNodeDependencies({ env, pool })` and return the identity, complete `IntegrityGuard`, reviewed genesis, bootstrap peer allowlist, trusted issuer IDs, storage-headroom provider, and real storage lifecycle/status adapters. Trust material and adapter code must be provisioned outside the repository and must not be writable by the node account.
- `cloud/README.md` identifies the cloud UI as a static local preview, not a connected cloud service.
- `package.json` declares `pg` as a runtime dependency. `package-lock.json` includes the registry-backed dependency graph and integrity hashes. CI uses `npm ci --no-audit --no-fund` and separately runs `npm audit --omit=dev --audit-level=high`. A checksum-tracked PostgreSQL migration runner and `npm run db:migrate` command are also present.

The executable composition gap is now partially addressed, but this is **not a turnkey production deployment**: no deployment-specific adapter, trust bundle, real storage backend, capacity telemetry, credentials, or operational recovery evidence is included in the repository. Do not interpret unit tests, the CI PostgreSQL integration test, or this runbook as proof that a production node can be safely deployed. Do not add placeholder trust values or silently fall back to in-memory admission to make startup appear successful.

## Official launcher invocation

Provision the adapter module and every trust/configuration file it reads through a deployment-controlled channel with read-only permissions for the node account. Then set the following environment variables in the service manager (do not commit credentials or secrets):

```sh
ZION_OFFICIAL_ADAPTER_MODULE=/etc/zion/official-adapter.mjs
ZION_POSTGRES_URL=<deployment-injected PostgreSQL connection string>
ZION_POSTGRES_POOL_MAX=10
npm run start:official
```

The adapter module must export `createOfficialNodeDependencies({ env, pool })`. It must return `integrityGuard`, `identity`, `protocolGenesis`, `trustedPeerIds`, `trustedIssuerNodeIds`, `storageHeadroomProvider`, `startStorage`, and `stopStorage`. It may also return `getStorageStatus`, `recordContainmentEvent`, `storeOptions`, `admissionOptions`, `transportOptions`, and `bootstrapOptions`. The launcher rejects missing core dependencies and closes the pool if adapter initialization or startup fails. The PostgreSQL pool size is bounded to 1–100 connections (default 10).

This command does **not** run database migrations. Apply and verify migrations as a controlled release operation first. The launcher is only as trustworthy as the adapter module and the external trust/configuration it supplies; do not use a module or configuration writable by the node process itself. Confirm startup and shutdown against the actual deployment adapter before routing external traffic.

## 1. Preflight — do not open the listener yet

- [ ] Pin the release commit and record its SHA in the change record.
- [ ] Provision PostgreSQL using deployment-managed credentials and least-privilege roles. Do not place credentials in source control or logs.
- [ ] Verify the target database identity and connectivity from the same runtime that will host the node.
- [ ] Apply migrations with `ZION_POSTGRES_URL=... npm run db:migrate` (or `DATABASE_URL=... npm run db:migrate`) from a controlled release job. The runner takes a PostgreSQL advisory lock, records SHA-256 checksums in `zion_schema_migrations`, applies each migration and its ledger row in one transaction, and refuses edits to an already-applied migration. If it cannot confirm release of the advisory lock, it destroys that database client and exits with `ZION_MIGRATION_LOCK_RELEASE_FAILED`; if the lock-acquisition reply is ambiguous, it also destroys the client rather than returning a possibly locked session to the pool. The migration may already have committed when release is uncertain, so inspect the ledger and schema before retrying rather than assuming rollback. Verify the recorded migration ID/checksum and resulting schema before startup. Never edit an applied migration; ship a new migration instead.
- [ ] Confirm `OfficialNodeBootstrap.start()` completes the `verifyPersistentState()` preflight before the listener is opened; it must reject missing policy/capacity rows, invalid policy values, reservation-count drift, or active admissions with inconsistent issuer/nonce evidence.
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

## 3. Shutdown and containment checks

- [ ] Verify shutdown closes authenticated notification ingress before draining background work.
- [ ] Verify inactivity and idle schedulers stop accepting new work and await active evaluations before storage shutdown.
- [ ] Verify the notification delivery worker aborts in-flight provider calls, persists or fences ambiguous delivery outcomes, and drains before storage shutdown.
- [ ] Verify the contribution audit scheduler's `stop()` and `close()` await any active durable audit before storage dependencies are closed.
- [ ] Inject timer-cleanup failures and confirm active work is still drained, shutdown reports incomplete cleanup, and a retry is possible.
- [ ] Inject a transient storage-stop failure and confirm the launcher retains the PostgreSQL pool until shutdown is confirmed; retry and verify the pool closes only after successful cleanup.
- [ ] Record the exact tested commit and the state reported by transport/storage adapters; missing status adapters must not be described as independently verified shutdown.

## 4. Failure and recovery drills

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

## 5. Go/no-go criteria

Do not enable an official deployment until all are true:

- [ ] The `start:official` launcher is exercised with the actual deployment-owned adapter module, and that adapter/configuration is independently reviewed.
- [ ] All admission correctness and failure drills above have recorded passing evidence.
- [ ] Backup restore and migration recovery have been demonstrated by someone other than the implementer where feasible.
- [ ] Database credentials, genesis, allowlists, and issuer trust are provisioned outside the repository.
- [ ] Monitoring and operator procedures exist for database outage, capacity-provider failure, ambiguous COMMIT, stale active rows, and restore/fencing.
- [ ] The exact release commit has passing CI and security checks.
- [ ] A rollback/disable plan exists that does not silently switch official mode back to in-memory admission.

## 6. Evidence template

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
