# Changelog

## 0.33.32 — Continuity and release-evidence restoration

- Restored the v0.33.20 and v0.33.30 audit reports into the distributable source tree.
- Reconstructed omitted v0.33.25–0.33.29 and v0.33.31 changelog entries from the corresponding preserved audit reports and release artifacts.
- Added an explicit continuity report and a file-level SHA-256 manifest in the preservation bundle.
- No runtime behavior changes are intended in this release; this is a documentation, provenance, and backup-integrity release.

## 0.33.31 — Signed Witness durable staging

- Added the reusable signed temporary-staging API for Witness publication, with explicit content and sidecar persistence ordering.
- Preserves signature, session-validation, hash/size verification, replay-ledger, and no-replace commit requirements of the recovery path.
- The session authority remains an integrator dependency; local staging does not prove power-loss durability across all filesystems.

## 0.33.30 — Persistent Witness replay protection

- Added a cross-process exclusive lock around temporary recovery and a durable replay ledger scoped to the data root.
- Reserves nonce use before commit, rejects conflicting metadata reuse, fails closed on malformed ledger state, and supports safe cleanup resumption when the committed destination matches the reserved operation.
- Added process-level crash and concurrent recovery regression coverage.

## 0.33.29 — Witness crash and concurrency verification

- Added child-process SIGKILL recovery coverage after the temporary and signed sidecar are synchronized.
- Added a two-process recovery race test verifying a single no-replace commit winner.
- These tests do not simulate power loss or certify network filesystems.

## 0.33.28 — Signed Witness temporary recovery

- Added signed ownership metadata, strict temporary recovery decisions, forensic quarantine, and audit events for recovered or rejected artifacts.
- Added tests for signature/session/content rejection, orphan recovery, idempotency, and destination conflicts.
- The session validator is supplied by the integrator; hardware persistence is not independently proven.

## 0.33.27 — Invisible consumer client

- Added a consumer-facing client API for chunked authenticated encryption, manifest integrity checks, local screening, and ciphertext-only adapter storage.
- The in-memory adapter is a test/demo implementation, not durable distributed storage.

## 0.33.26 — Content admission and governance

- Added local content-screening and uploader-attribution verification hooks, with fail-closed policy handling and regression coverage.
- Screening policy integration is not a substitute for a complete network-wide moderation or legal process.

## 0.33.25 — External trust-anchor receipt verification

- Added offline Ed25519 verification for externally issued trust receipts, including authority identity, checkpoint binding, freshness, expiry, and sequence-floor checks.
- The authority public key and minimum sequence must be provisioned independently.

## 0.33.24 — Read-only persistent trust-state diagnostics

- Added `anchor:diagnose-trusted-state` to inspect the persisted monotonic pin and its exclusive lock without changing either file.
- Validates the state schema and canonical-body SHA-256; checks regular-file constraints, bounded reads, no-follow opening where supported, and metadata stability.
- Reports lock PID liveness only as advisory and never auto-removes stale locks; outputs conservative operator recovery guidance.
- Added tests for missing state, valid state/lock, corrupt state, and symlink rejection.
- Does not establish remote freshness or protect against an attacker who can roll back both local history and state.

## 0.33.22 — External rollback and freshness policy

- Added an optional out-of-band rollback policy for trusted checkpoint-history verification.
- Can enforce a minimum registry revision, exact expected head checkpoint SHA-256, minimum head issue time, and maximum age of the latest checkpoint without incorrectly requiring old historical checkpoints to be recent.
- CLI accepts an optional sixth `rollback-policy.json` input; absent policy preserves v0.33.21 behavior and is explicitly reported in verification output.
- Added tests for revision rollback, head hash pinning, stale heads, malformed policy, and future-dated head handling.
- Read-only; no automatic trust updates, cleanup, GitHub publication, or production deployment.

## 0.33.21 — Trusted checkpoint-chain verification

- Added `anchor:verify-trusted-history` to verify every checkpoint signature against an out-of-band initial trust policy and a complete signed key-rotation chain.
- Validates the append-only revocation event chain using a separately supplied Ed25519 revocation-authority public key; fails closed when a checkpoint signer or the currently active signer is revoked.
- Rejects missing chain starts, non-advancing/forked checkpoints, unknown signer keys, invalid signatures, broken rotation/revocation chains, and malformed or untrusted policy inputs.
- CLI inputs are bounded, opened without following symlinks where supported, restricted to regular files, and checked for metadata changes during reads. Verification is read-only.
- Added adversarial tests for rotation, truncation, tampering, unknown signers, and revocation. This remains dependent on the operator supplying authentic initial trust and revocation-authority keys out of band.

## 0.33.20 — Offline Witness evidence verification

- Added `anchor:verify-witness-evidence` to verify a saved response's Ed25519 signature, expected witness/key identity, minimum sequence, challenge-window consistency, and binding to the head hash of a supplied checkpoint history.
- Reads evidence/history/key files with no-follow regular-file checks, bounded input sizes, and before/after metadata comparisons; rejects symlinks, oversized files, and detected concurrent changes.
- Added regressions for valid evidence, tampered signatures, identity mismatch, sequence rollback, history-head mismatch, symlink input, and oversized evidence.
- Offline verification explicitly does not prove current freshness or anti-replay and does not independently validate checkpoint-chain signatures or external trust-registry status. No recovery, deletion, or overwrite is performed.

## 0.33.19 — Bounded Witness artifact inspection

- Caps diagnostic content reads at 1 MiB to avoid unbounded memory use on malformed or hostile temporary artifacts.
- Reports oversized artifacts without reading or hashing their content.
- Compares file identity, size, and timestamps before and after inspection; files that change during inspection are reported as inconclusive, without content classification or hashing.
- Added regression coverage for oversized temporary artifacts.

## 0.33.18 — Read-only Witness temporary-artifact diagnostics

- Added `anchor:diagnose-witness-evidence` to inventory only the exact UUID temporary names used by the Witness evidence publisher.
- Classifies JSON-syntax-valid or malformed orphan files without treating syntax as signature/trust validation; detects post-publication hard-link aliases by device/inode identity.
- Uses no-follow regular-file reads, emits byte count/mode/SHA-256 metadata, and never deletes, renames, promotes, or overwrites artifacts.
- Added regressions for orphan classification, hard-link aliases, unrelated names, symlinks, and preservation of existing bytes.
- This is a read-only local filesystem diagnostic, not an automated recovery mechanism or a guarantee of crash/power-loss durability.

# Changelog

## 0.33.16 — Cross-process evidence publication race

- Added a child-process regression that launches two independent Node.js processes attempting to publish valid, independently challenged Witness evidence to the same destination.
- Verifies exactly one process commits, the competing process fails without replacing the winner, the final evidence is parseable and private (`0600`), and temporary files are cleaned up.
- This exercises a real cross-process filesystem race on the test host; it does not simulate power loss or certify network/distributed filesystems.

## 0.33.15 — Expired TLS certificate rejection

- Added a deterministic, expired localhost server certificate fixture signed by a dedicated test CA.
- Added a real HTTPS handshake regression proving that trusting the issuer does not bypass certificate validity checks.
- Existing TLS regressions continue to cover a trusted certificate with matching hostname, hostname mismatch, and an untrusted issuer.
- Test certificates and private keys are strictly test-only and must never be used in production.

## 0.33.14 — Witness recovery boundaries and request policy

- Added a recovery regression proving an orphaned temporary file does not block a fresh publication when the destination is absent. The orphan is preserved because ownership cannot be safely inferred.
- Added a signature-verification regression proving a response signed by an unrelated Ed25519 key never becomes evidence.
- Added an explicit client-policy regression for redirect rejection and deadline signal configuration.
- These tests cover deterministic local behavior; they do not prove arbitrary power-loss durability or production TLS/CA behavior.

## 0.33.13 — Witness TLS handshake regression tests

- Added real local HTTPS handshake tests for a trusted CA and matching hostname.
- Added rejection tests for a hostname mismatch and an untrusted certificate authority.
- Uses test-only certificate fixtures and no external network.
- Does not claim expired-certificate coverage or production deployment validation.

## 0.33.12 — Atomic witness evidence publication

- Changed evidence publication to write and fsync a private temporary file, then atomically link the complete inode into the destination without replacement.
- Syncs the destination directory after publishing and after removing the temporary name.
- Avoids deleting a successfully linked evidence file when a later directory fsync reports an error; such an error is surfaced while preserving the potentially durable evidence.
- Retains exclusive-create semantics (`EEXIST`) and the existing evidence integrity checks.

## 0.33.11 — Evidence commit race and interrupted-body hardening

- Added a regression proving a response-body read interruption never creates witness evidence.
- Added a valid signed-response test proving existing evidence is not overwritten.
- Added concurrent success coverage proving exclusive evidence creation yields exactly one winner for a shared output path.
- These tests cover local client behavior; they do not establish crash consistency on every filesystem or test a live external TLS certificate chain.

## 0.33.10 — Witness client transport-failure regressions

- Added deterministic client tests for network interruption, HTTP 503, non-JSON gateway responses, truncated JSON, and oversized bodies.
- Each failure path is verified not to create the evidence output file; incomplete responses are never accepted as witness evidence.
- These tests exercise injected fetch failures, not real-world TLS certificate-chain deployment or arbitrary socket timing.

## 0.33.9 — Witness fail-closed recovery regressions

- Added process-level integration coverage proving corrupt committed Witness state returns HTTP 503 and is preserved byte-for-byte.
- Added process-level coverage proving an abandoned Witness state lock returns HTTP 503 and is not automatically removed or stolen.
- These tests document conservative operator-led recovery; they do not claim recovery from arbitrary filesystem, hardware, or distributed-lock failures.

## 0.33.8 — Witness recovery and reproducible operational audit

- Added lock permission regression coverage and consolidated recovery/audit scope.

## 0.33.2 — Client credential rotation and audit

- Added JSON credential registry with per-client IDs and enabled/revoked state; credentials reload on each request so rotation and revocation take effect without restarting the service.
- Preserved legacy single-token file compatibility.
- Added structured authentication and rate-limit audit events without logging bearer secrets.
- Credential-store parse/read errors fail closed with HTTP 503. Rate limits remain per process and require a trusted shared gateway for cluster-wide enforcement.

## 0.33.1 — Rate limits and multi-process regression coverage

- Added a bounded per-process rate limiter for authenticated requests, keyed by remote address and bearer credential; returns HTTP 429 with `Retry-After` when the limit is exceeded.
- Added a bounded limiter-key table that fails closed under cardinality pressure rather than growing without bound.
- Require `Content-Type: application/json` before parsing challenge requests.
- Added integration coverage proving two server processes sharing one state file serialize sequence increments without duplicate sequence values.
- Rate limiting is per process, not cluster-wide; use a trusted reverse proxy or shared gateway for distributed limits. Stale state locks still fail closed and require operator intervention.

## 0.33.0 — Authenticated remote witness client

- Added required bearer-token client authentication to the remote witness challenge endpoint.
- Read token from a separate regular file, require at least 32 bytes, and compare supplied authorization values with `timingSafeEqual`.
- Reject unauthenticated requests before reading or mutating witness state; integration test covers unauthorized and authorized/replay-after-restart paths.
- Bearer tokens require TLS when crossing a network; rate limiting and client-specific credentials are not yet implemented.

## 0.32.99 — Durable remote witness state

- Persisted consumed challenge nonces alongside the monotonic sequence, retaining replay protection across process restarts.
- Added bounded cross-process locking; lock timeouts and stale locks fail closed rather than being stolen automatically.
- Added file and parent-directory fsync around atomic state replacement; no success response is signed if persistence confirmation fails.
- Added restart replay regression coverage and a bounded nonce table that refuses new challenges at capacity rather than evicting unexpired records.
- Snapshot rollback remains outside the protection boundary; no production deployment is implied.

## v0.32.98 — Remote witness service

- Added an opt-in HTTP endpoint for short-lived signed freshness challenges.
- Added serialized sequence persistence, bounded request bodies, strict challenge validation, no-store response headers, and in-process nonce replay rejection.
- Added integration coverage for signature verification, sequence persistence, and replay rejection.
- Security limitation: not intended for direct public exposure; restart-safe nonce consumption and rollback-resistant sequence storage remain open.

## 0.32.96 — Independent freshness witness quorum

- Adds threshold verification across multiple independently keyed Ed25519 freshness witnesses, each bound to the exact head of the signature-verified checkpoint history.
- Integrates `--freshness-quorum-manifest` into read-only anchor diagnostics; manifest-relative witness and public-key paths are opened as regular files without following symlinks where supported.
- Rejects malformed quorum policy, duplicate witness/key identities, stale or invalid evidence, mismatched history heads, and threshold failures.
- Reports verified threshold and witness identities; `--require-freshness-witness` accepts either a single witness pair or a quorum manifest, never both.
- Adds unit and diagnostic integration tests, including read-only behavior and duplicate-membership rejection.
- Quorum is only meaningfully independent when membership and public keys are provisioned outside the audited storage domain. It does not provide a rollback-proof local sequence counter or a remote witness transport.

## 0.32.95 — Integrated freshness witness diagnostics

- Integrates Ed25519 freshness-witness verification into read-only anchor diagnostics.
- Binds the signed witness to the exact head checkpoint of the signature-verified history.
- Adds CLI inputs for witness JSON, independently provisioned witness public key, expected key ID, minimum sequence, witness-specific maximum age, and an explicit required-witness mode.
- Stale, malformed, mismatched, below-floor, or invalidly signed witness evidence fails closed and requires operator attention.
- Adds integration tests for valid/read-only verification, stale evidence, and missing required inputs.
- Does not persist a monotonic sequence floor, implement witness quorum, or claim protection against rollback when all trust state is rollbackable.

## 0.32.91 — Integrated signed key rotation diagnostics

- Integrates signed rotation-chain verification into read-only anchor diagnostics.
- Adds `--rotation-history`; rotation requires an externally provisioned `--trust-policy`.
- Resolves the active signer key before verifying checkpoint history and reports tampered/incomplete rotation chains as untrusted.
- Adds positive and tampering regression tests; no automatic key trust, revocation, or remote freshness witness is implied.

## [0.32.80] - Crash-recovery fail-closed validation

- Added an independent-process test that creates and fsyncs the anchor lock, then exits abruptly.
- Verified a later publisher times out and preserves the abandoned lock rather than guessing it is safe to steal.
- Operators must inspect the owning process and checkpoint directory before manually removing a stale lock.
- No remote anchor service or production deployment is configured by this release.

## [0.32.79] - Cross-process persistent anchor hardening

- Add real independent-Node-process tests proving identical checkpoint publication is serialized and idempotent.
- Add competing-process fork tests proving one checkpoint wins and a same-revision conflict cannot overwrite it.
- Close the checkpoint symlink check/read race on platforms supporting `O_NOFOLLOW` by opening once and validating the opened file descriptor.
- Preserve fail-closed behavior for pre-existing locks; no automatic stale-lock stealing was introduced.
- Scope: this remains a file-backed adapter for compatible shared filesystems, not distributed consensus or a configured remote production anchor.

## [0.32.76] - Signed audit anchor checkpoints

- Add Ed25519-signed checkpoints binding a trust-registry revision, registry digest, and audit-chain head.
- Verify checkpoint signatures, signer identity labels, age policy, and checkpoint structure.
- Compare observed checkpoints against an independently retained trusted checkpoint to detect rollback, same-revision forks, and broken checkpoint ancestry.
- Refuse to create checkpoints from registry files with invalid outer digests or unsafe symlink/non-regular-file paths.
- Checkpoint persistence is delegated to an external independent anchor adapter; this module does not claim that a local checkpoint is independently anchored.
- Add tests for signature tampering, expiry, rollback, forks, chain breaks, and invalid registry data.

## [0.32.75] - Concurrent trust registry and tamper-evident audit chain

- Serialize trust-key registration and revocation across local Node.js processes with an exclusive lock file, bounded wait, and conservative stale-owner recovery.
- Reload the latest registry only after acquiring the lock so concurrent writers do not overwrite each other's revisions.
- Add per-event SHA-256 chaining to new trust and revocation audit events and verify the chain during every registry load.
- Reject event alteration even if an attacker recomputes the outer registry digest without rebuilding the event chain.
- Add independent-process contention coverage and audit-chain integrity tests.
- Scope: coordination is for processes sharing a compatible local filesystem; it is not distributed consensus and does not resist an administrator who can rewrite the complete registry and chain.

## [0.32.72] - Recovery decision and approval workflow

- Add durable, append-only operator decisions bound to the exact reconciliation report SHA-256.
- Require an explicit approver and rationale; supported decisions are keep pending, investigate, or authorize a manual retry review.
- Approval records explicitly state that no delivery execution occurred; this module never invokes providers or mutates notification state.
- Revalidate the current case digest when reading decisions and mark approvals stale if the case report changes.
- Publish decision records exclusively, use restrictive file permissions, and sync the record and directory.
- Add tests for digest binding, stale approval rejection, integrity verification, and the no-execution boundary.

## [0.32.69] - Durable recovery audit record

- Persist a unique, exclusive recovery audit JSON record after restore verification, including the pre-inspection hashes, restored digest, record count, preserved-copy path, confirmation, and timestamp.
- Sync the audit file and containing directory before reporting full success.
- If the state is restored but audit durability cannot be confirmed, return a distinct `NOTIFICATION_RECOVERY_AUDIT_UNCONFIRMED` error with `commitVisible: true`; callers must not blindly retry the restore.
- Audit records exclude notification message bodies and notification IDs.
- Extended recovery tests to verify the durable audit artifact and privacy boundary.

## [0.32.68] - Explicit recovery and forensic preservation

- Added `InactivityNotificationStore.recoverLastGood()` for operator-confirmed recovery from a validated `.last-good` snapshot.
- Requires exact SHA-256 hashes from a recent inspection and rechecks them under the local cross-process file lock to reject stale assessments.
- Refuses to overwrite a valid canonical state and validates the recovery snapshot before mutation.
- Preserves corrupt canonical bytes to a unique, exclusive file and syncs it before atomically replacing the canonical state.
- Returns a structured recovery result with source, restored digest/count, preserved-copy path, and confirmation metadata; reports uncertain directory durability distinctly.
- Added tests for explicit confirmation, stale inspection, byte-for-byte forensic preservation, successful restore, and refusal to overwrite valid state.

## [0.32.67] - Read-only recovery assessment

- Added `InactivityNotificationStore.inspectRecovery()` to validate the canonical and `.last-good` snapshots without changing either file.
- Reports SHA-256 digests, validity/error codes, record counts, and validated record-ID differences without exposing notification bodies.
- Rejects symlinks and non-regular files; never automatically restores a snapshot.
- Added regression coverage for valid snapshot comparison, corrupt canonical preservation, and symlink safety.

## [0.32.66] - Last-good recovery snapshot

- Preserve the previously validated canonical notification state as an atomic `.last-good` recovery artifact before replacing the canonical snapshot.
- Recovery artifacts are never restored automatically; corrupted canonical data remains untouched and startup fails closed.
- Reuse persisted-state validation for canonical and backup content and clean only exact store-generated temporary backup names after canonical validation.
- Added regression coverage for prior-state preservation and no automatic rollback to a potentially stale snapshot.

## [0.32.65] - Corruption-safe state loading

- Add explicit corruption/invalid-state error codes without overwriting original persisted data.
- Validate canonical state before cleaning temporary snapshots, preserving recovery evidence if canonical state is corrupt.
- Reject duplicate notification IDs and duplicate owner-scoped event keys.

## [0.32.64] - Abandoned temp snapshot recovery

- Under the local inter-process lock, remove only store-generated UUID `.tmp` snapshot artifacts left by a process that terminated before atomic rename.
- Use `lstat` and unlink matching symlinks without following them; leave directories and unrelated similarly named files untouched.
- Added regression coverage for partial temp files, temp symlinks, and preservation of unrelated files.
- Cleanup is best-effort for availability, not a substitute for fsync guarantees or corruption recovery of the canonical state file.

## [0.32.63] - Directory fsync contract

- Directory fsync failures after atomic rename are no longer silently swallowed.
- Report `NOTIFICATION_STORE_DURABILITY_UNCONFIRMED` with `commitVisible: true` while keeping the in-memory snapshot aligned with the canonical file, avoiding a false rollback after rename.
- Added a regression test for uncertain directory durability and idempotent retry after the commit becomes visible.

## [0.32.62] - Durable snapshot rollback

- Restore the last known durable snapshot when state persistence fails before commit.
- Add regression coverage for atomic replacement failure and phantom in-memory mutations.

## [0.32.61] - Real crash-window verification

- Added a child-process test that durably records dispatch intent and terminates with a non-zero exit before cleanup, then reconstructs the store after lease expiry.
- Verifies recovery fences the record into `ambiguous` and removes the stale intent instead of making the notification eligible for blind resend.
- This validates persisted protocol behavior across an abrupt process exit; it does not simulate power loss, storage-controller cache loss, or guarantee filesystem durability on every platform.

## [0.32.60] - Safe policy-adapter delivery

- Hardened the optional inline policy adapter to use delivery claims and durable dispatch intent before external side effects.
- Provider exceptions and receipt-persistence failures now transition to ambiguity instead of silently leaving a notification pending for blind resend.
- Repeated policy events that already have a delivered or ambiguous record no longer trigger another inline provider send.
- Added regression coverage for uncertain provider outcomes in the policy adapter.

## 0.32.58 — Graceful shutdown for notification delivery
- Added a worker lifecycle AbortController and propagates shutdown cancellation to active delivery/reconciliation adapters.
- Graceful shutdown no longer waits for the full provider timeout when an adapter supports AbortSignal; delivery interrupted during shutdown is persisted as ambiguous, never blindly retried.
- Reconciliation interrupted by shutdown releases its claim while preserving the ambiguous state for a later worker.
- Added a regression test for shutdown during a hanging provider operation.
- Adapter cancellation is cooperative: providers that ignore AbortSignal may continue running remotely; provider idempotency and reconciliation remain necessary.

## 0.32.57 — Crash recovery and restart verification
- Added real child-process regression coverage that exits without releasing a persisted delivery claim, then verifies a restarted process respects the lease and recovers it after expiry.
- Added restart coverage proving an ambiguous provider outcome remains persisted and is reconciled before any resend after store reconstruction.
- Verifies a stale claim token from the terminated process cannot confirm delivery after a new claim is issued.
- This release adds crash/restart tests; it does not claim exactly-once delivery, multi-host locking, or production deployment.

## 0.32.56 — Bounded delivery and reconciliation timeouts
- Added a configurable provider/reconciliation timeout bounded below the delivery lease, so a hung adapter cannot hold the worker loop indefinitely.
- Passes an `AbortSignal` to provider adapters; timeout during delivery is classified as an ambiguous outcome and is never blindly retried. Adapters must honor cancellation where possible; the worker still treats non-cooperative adapters as uncertain.
- Reconciliation timeout releases the claim while preserving the persisted ambiguous state for a later check.
- Added regression tests for hanging providers, hanging reconciliation, abort signals, and timeout/lease configuration validation.
- This is a local worker hardening change; no real provider is bundled and it does not provide distributed multi-host locking.

## 0.32.55 — Ambiguous delivery reconciliation
- Added a persisted `ambiguous` delivery state so provider outcomes that cannot be determined are not blindly resent; explicit unknown outcomes and common network timeout/reset errors enter this state.
- Added an explicit reconciliation adapter contract: `delivered` requires a provider receipt, `not-delivered` returns the item to retryable pending state, and `unknown` preserves the ambiguity.
- Added authenticated history filtering for ambiguous notifications and validation of ambiguity metadata in persisted state.
- Provider adapters must explicitly return `{ outcome: 'unknown' }` when acceptance cannot be established. No provider-specific reconciliation is included; without a `reconcile` adapter, ambiguous records remain held for manual/provider-side resolution.

## 0.32.54 — Validated delivery state and claim fencing
- Added strict validation for persisted notification record bounds, timestamps, delivery receipt invariants, and paired delivery-claim/lease fields; malformed state fails closed at load time.
- Bound worker attempt recording to the active claim token, so a stale worker cannot mutate attempt counters after a newer lease is acquired.
- Added regression tests for stale-token attempt rejection and corrupted persisted claim state.
- Legacy direct delivery through `createInactivityNotificationAdapter` remains for compatibility; it does not use claim fencing and should not be used as a substitute for the coordinated worker in multi-worker deployments.

## 0.32.53 — Delivery-claim failure recovery
- Moved attempt persistence into the delivery worker's claim-protected error boundary. If persisting the attempt fails, the worker now releases its claim instead of leaving the notification blocked until lease expiry.
- Added a regression test proving a failed attempt write does not strand the claim.
- This is a reliability fix, not a provider integration; ambiguous provider outcomes still require provider-side idempotency/reconciliation.

## 0.32.52 — Idempotent and leased notification delivery
- Added persisted, owner-scoped delivery claims with bounded leases so independent workers sharing the same local outbox do not normally deliver the same pending record concurrently.
- Claims are released after failed/ambiguous provider calls and expire after worker crashes; stale claim tokens cannot confirm delivery.
- Every provider attempt receives a stable `zion-inactivity-notification:<id>` idempotency key for providers that support deduplication.
- Added tests for concurrent independent workers, stable idempotency keys, lease expiry/recovery, and stale-token rejection.
- Delivery remains at-least-once if a provider does not support idempotency or acceptance/receipt is ambiguous. This does not provide cross-host coordination or prove production deployment.

## 0.32.51 — Cross-process notification outbox coordination
- Added an exclusive filesystem lock around outbox reads and mutations, with bounded wait, safe stale-lock recovery for dead owners, symlink rejection, and a fresh state reload while holding the lock.
- Separate store instances and Node.js processes sharing the same state path now serialize changes rather than overwriting stale in-memory snapshots.
- Added best-effort directory fsync after atomic replacement and tests for concurrent instances, real multi-process writes, and lock-file symlink rejection.
- Scope remains a single host with a filesystem that honors exclusive file creation and atomic rename; this is not a distributed lock for network filesystems or multi-host deployments.

## 0.32.50 — Notification runtime composition and lifecycle wiring
- Added `createInactivityNotificationRuntime()` to compose the owner-scoped policy notification callback, persistent outbox, authenticated history API, and bounded delivery worker using explicit host adapters.
- `OfficialNodeBootstrap` can now start the notification API only after integrity, storage, and transport are healthy, and close it during rollback, shutdown, or quarantine.
- Added an end-to-end test covering policy event → persistent pending record → provider receipt → authenticated API listing → viewed timestamp, plus lifecycle and missing-owner tests.
- Documented the host integration contract and remaining deployment constraints: trusted identity directory/provider adapters, single-writer local-file storage, TLS ingress for remote binding, and at-least-once delivery semantics.
- This release does not configure a real provider or claim production deployment.

## 0.32.49 — Lifecycle-managed notification delivery retries
- Added an opt-in outbox delivery worker with owner-scoped scans, bounded batches, exponential backoff, retry ceiling, concurrency coalescing, and explicit provider-receipt confirmation.
- Wired the worker into `OfficialNodeBootstrap`: it starts only after integrity/storage/transport startup and stops before transport/storage cleanup, including rollback and quarantine.
- Added tests for delivery receipts, backoff, provider failure, concurrent runs, invalid owner sources, and bootstrap lifecycle ordering.
- Limitation: host must supply a trusted owner directory and a real provider adapter. Exhausted records remain pending for operator intervention; exactly-once delivery is not guaranteed and no production deployment is claimed.

## 0.32.47 — Authenticated inactivity notification history API
- Added an opt-in HTTP API to list the authenticated owner's persisted inactivity notifications and mark them viewed.
- Identity is derived exclusively from the trusted bearer session; cross-owner lookups return 404, provider receipts and internal owner/deduplication fields are omitted, and the browser cannot forge delivery confirmations.
- Added a bounded Cloud API client and documentation for host wiring, secure local binding, and TLS-ingress responsibilities.
- Fixed inactivity threshold comparisons to use the same immutable option snapshot throughout each evaluation.
- Validation: 298-test suite, syntax check, demo, and archive integrity are verified in the release process below.
- Limitation: API lifecycle/ingress wiring is opt-in; this does not constitute production deployment or a push/email delivery service.

## 0.32.46 — Durable inactivity notification outbox
- Added an owner-scoped persistent outbox for inactivity warnings, pause/reduction status, bounded metadata, deduplication keys, attempt counts, delivery receipts, and viewed timestamps.
- Notifications are marked delivered only after an explicit provider receipt; a queued or viewed notification is not represented as delivered.
- Pending records are never silently evicted when the bounded outbox is full; only delivered records may be evicted.
- Added a policy callback adapter and tests for persistence, owner isolation, deduplication, receipt confirmation, capacity handling, and validation.
- Limitation: this is a local outbox primitive, not a push provider or retry worker. Cross-process shared-file locking and production notification transport remain host responsibilities.

## 0.32.45 — Live inactivity policy settings bridge
- Added an explicit bridge that loads the authenticated node owner's saved inactivity settings and applies validated options to the running policy.
- Rejects missing authentication and identity mismatch; failed application preserves the existing policy configuration.
- Added atomic live option replacement and per-evaluation immutable option snapshots to avoid mixed thresholds during asynchronous callbacks.
- Added tests for successful live application, owner isolation, missing authentication, malformed settings, and invalid bridge setup.
- Limitation: host startup/save wiring, cross-process propagation, and production notifications remain host responsibilities; no production deployment is claimed.

# Changelog

## 0.32.39 — Inactivity policy storage adapter
- Added a durable, atomically updated shared quota configuration for the opaque replica store; capacity updates are serialized with writes and rejected when actual occupied bytes exceed the target.
- Store instances reload the shared quota under the storage lock before admitting new chunks, so capacity changes survive restart and coordinate across instances sharing the same storage root.
- Added an adapter for `InactivityResourcePolicy` that reads verified inventory bytes and delegates migration only to an explicit host callback.
- Added tests for safe quota updates, unsafe reduction rejection, inventory verification, and invalid adapter wiring.
- Limitation: production startup wiring, durable owner-facing notifications, and contribution pause/resume adapters remain outstanding. A host must not run multiple independent quota roots for the same logical node. No replicas are deleted.

## 0.32.37 — Inactivity pause and capacity reduction safeguards
- Added configurable inactivity stages: advance warning, contribution pause, capacity-reduction warning, and delayed capacity reduction.
- Added persistent state, duplicate-notification suppression, and restoration of contribution/capacity on verified renewed activity.
- Capacity reduction is blocked when occupied bytes exceed the target unless a migration adapter reports success and usage then fits; no file deletion or replica eviction is performed by this policy.
- Added tests for warning timing, persistence, resumption, reduction and fail-safe migration blocking.
- Added policy documentation and explanatory UI settings. The UI remains a preview and is not wired to a live node.

## 0.32.36 — Identity-bound challenge authentication
- Added one-time Ed25519 challenge-response authentication bound to registered social identities.
- Added short-lived opaque bearer sessions; only token hashes are retained, and sessions can be revoked.
- Integrated session authentication into the social HTTP node so senders can only send as their own identity and inbox/ack operations are restricted to the authenticated recipient.
- Added tests for wrong-key proof, challenge replay/expiry, session expiry/revocation, and HTTP cross-account isolation.
- Sessions are in-memory and expire on restart; this remains an experimental local service, not production authentication or public-network delivery.

## 0.32.35 — Identity-bound social transport
- Added a persistent local social identity directory with proof-of-possession registration and stable key-fingerprint identity IDs.
- Added public profile lookup endpoints when a directory is configured.
- Bound message sender IDs to directory signing keys and recipient IDs to registered profiles; signed acknowledgements are verified against the trusted recipient profile key.
- Fail closed for inbox reads unless an explicit per-recipient inbox-access authorization callback is configured.
- Added integration tests for profile lookup, identity-bound send, signed acknowledgement, and sender spoof rejection.
- The directory remains local and is not a global identity consensus, Sybil defense, key recovery system, or production authentication service.

## 0.32.33 — Signed delivery acknowledgements
- Added recipient-signed, timestamp-bounded acknowledgements for queued messages.
- Made the social message node reject unsigned or invalid acknowledgements by default.
- Added tests for valid receipt, unsigned receipt, and tampering.


- Added a durable, bounded inbox for opaque encrypted envelopes, with expiry, recipient quotas, global quotas, idempotent enqueue, polling, and explicit acknowledgement.
- Added tests for restart persistence, recipient isolation, deduplication, quotas, stale payload rejection, and acknowledgement behavior.
- This is a local storage primitive only: no public API, peer authentication, network delivery, or production deployment is claimed.

## 0.32.30 — Experimental private-message cryptographic core

- Added a message envelope using ephemeral X25519 key agreement, HKDF-SHA-256, AES-256-GCM authenticated encryption, and Ed25519 signatures.
- Bound message identity/routing fields as authenticated data and added optional trusted sender-key verification.
- Added bounded message size/identifier checks and an in-memory replay guard with TTL and capacity limits.
- Added regression tests for round-trip decryption, recipient binding, tampering, trusted profile keys, input bounds, and replay behavior.
- This is a cryptographic building block only: no network delivery, durable identity/key management, ratchet/forward secrecy, persistent anti-replay, or independent security audit is claimed.

## 0.32.29 — Social interaction preview

- Added a Social and Messages area with profile search, follow/unfollow controls, conversation list, and message composition.
- Clearly labels social interactions as local-only; no message is represented as delivered to another user.
- Added responsive styles and documented the remaining requirements for real identity, secure delivery, abuse controls, and synchronization.

# Changelog

## 0.32.28 — Zion Cloud UI preview

- Added responsive Portuguese cloud UI preview and loopback-only static server.
- Added UI server smoke tests and documented demo-only behavior.

## 0.32.27 — Auditable containment events

- Add a bounded structured event history for quarantine containment and explicit shutdown.
- Support an optional asynchronous `recordContainmentEvent` adapter; audit-write failures are exposed separately and do not delay urgent resource isolation.
- Preserve contradictory adapter observations (`running`) instead of downgrading known active-resource evidence to `unknown`.
- Add bounded event details, a schema identifier, monotonic in-process sequence numbers, and tests for audit failure and active storage evidence.
- The optional callback is only a persistence integration point: durability, tamper resistance, and crash recovery depend on the configured external store and are not claimed by this release.

## 0.32.26 — Observable resource containment

- Track transport and storage lifecycle states separately from the bootstrap's logical state.
- Add optional adapter observations (`transport.getStatus()` and `getStorageStatus()`) to confirm whether resources are actually stopped.
- Expose a frozen `containmentReport` with per-resource states, verification evidence, and `verifiedStopped`.
- Containment retries now report `storageStopped` only when the adapter observation confirms the stopped state.
- If adapters lack observation methods, the command can complete but the report remains `unknown`/`unverified`; this avoids presenting a successful shutdown call as proof of resource termination.
- Add tests for verified shutdown, adapters that report a listener still active, and adapters without observation support.

## 0.32.20 — Runtime quarantine containment

- Require `addQuarantineListener()` in the official bootstrap guard contract.
- On runtime quarantine, close the official transport and stop started storage; reset lifecycle flags.
- Remove the bootstrap listener on explicit shutdown.
- Added regression coverage for quarantine after a successful start.
- This remains best-effort process-level containment, not secure boot.

# Changelog

## 0.32.23 — Lifecycle cancellation and shutdown serialization

- Add a lifecycle epoch so explicit shutdown and quarantine cancel an in-flight startup across asynchronous boundaries.
- Track the startup promise and have explicit `close()` drain it before final shutdown, preventing a delayed `listen()` from resurrecting the node.
- Preserve failed containment evidence when cleanup adapters fail; add deterministic regression coverage for `close()` racing with a pending listener bind.
- Validation remains local; no production readiness or public-network conformance is implied.

## 0.32.24 — Serialized lifecycle cleanup

- Serialize transport/storage shutdown adapter calls across quarantine containment, startup rollback, containment retry, and explicit close.
- Make concurrent close calls share one in-flight close operation.
- Add a deterministic regression test proving storage shutdown adapters do not overlap when quarantine, close, and retry are requested concurrently.
- Local test coverage does not establish production readiness or public-network conformance.

## 0.32.22 — Startup/quarantine race closure

- Re-check the integrity guard after the asynchronous network bind resolves, preventing a listener started during quarantine from being marked operational.
- Make startup rollback update containment status and preserve bounded cleanup errors; failed storage shutdown remains retryable and does not clear `storageStarted`.
- Add deterministic regression tests for quarantine during `listen()`, quarantine during storage startup, and repeated storage-stop failures during rollback.
- Validation is local; this does not establish production readiness or public-network conformance.

## 0.32.21 — Retryable fail-closed quarantine containment

- Track containment status separately from the node's operational `started` flag.
- Preserve `storageStarted` when the storage shutdown adapter fails; do not claim shutdown succeeded.
- Record bounded shutdown error messages and expose `retryContainment()` for an operator/runtime supervisor to retry while quarantine remains active.
- Test transport-close failure, storage-stop failure, and prohibition on retry before quarantine.
- Containment remains process-level and depends on the transport/storage adapters honoring their shutdown contracts.


## 0.32.18 — Official-mode maintenance integrity gate

- Replica maintenance now accepts explicit `networkMode: 'official'` and refuses construction unless a guard exposes `checkHealthy`, `assertHealthy`, and a status object.
- Official maintenance checks the current quarantine state and re-verifies local release integrity before catalog reads, recovery requests, or replication.
- Legacy mode remains the default for backward compatibility; it is not a statement of official-network conformance.
- Added tests for missing/incomplete guards and for zero catalog/peer access when official maintenance is quarantined.
- Local tests do not establish public-network readiness.

## 0.32.17 — Integrity-gated replica maintenance

- Recheck the local IntegrityGuard before catalog access, recovery requests, or replica writes.
- Fail closed with `local-integrity-not-healthy` when local integrity is unverified or quarantined.
- Added regression coverage proving no catalog or peer operations occur after the guard rejects maintenance.
- This release does not claim public-network readiness or remote proof of storage.

## 0.32.13 — Independent-process quarantine validation

- Added a three-node integration test that runs each Zion peer in a separate Node.js process.
- Validated that quarantine closes the compromised peer's listener and sessions while healthy peers continue authenticated communication.
- Added documentation describing the scope and limitations of the integration test.
- No production deployment or public-network test is implied by this release.

## 0.32.12 — Three-node isolation

- Added same-process transport isolation regression coverage.

## 0.32.19 — Fail-closed official node bootstrap

- Added `OfficialNodeBootstrap` to verify the signed release manifest and check the guard before opening storage or binding the official network listener.
- Rechecks integrity between storage startup and network bind; if integrity changes, startup aborts and started storage is rolled back.
- A failed network bind rolls back storage and closes the transport.
- Added ordering, bad-manifest, mid-startup quarantine, bind-failure, and configuration tests.
- This is startup orchestration, not OS secure boot; the trust key and manifest must be provisioned independently.

## 0.32.25 — Terminal bootstrap shutdown

- Make explicit `close()` latch a terminal state synchronously, before awaiting startup or adapter cleanup.
- Reject subsequent `start()` calls with `ZION_BOOTSTRAP_CLOSED`; restart requires constructing a fresh bootstrap so the quarantine listener cannot silently remain detached.
- Add deterministic tests for restart rejection and for a new start racing with close during a pending listener bind.
- This lifecycle guarantee applies to the bootstrap instance; process-level termination and adapter correctness remain deployment responsibilities.

## 0.32.32 — Authenticated social message transport adapter

- Add a minimal HTTP adapter over the persistent encrypted-message inbox, defaulting to loopback binding.
- Require a high-entropy bearer secret, explicit fail-closed sender/recipient authorization callbacks, signed-envelope verification, bounded request bodies, and per-IP rate limits.
- Add authorized inbox retrieval and recipient-scoped acknowledgement endpoints; health checks disclose no private queue data.
- Add integration tests for queue/send/retrieve/ack flow, unauthorized access, identity authorization failures, tampered envelopes, and health endpoint privacy.
- This adapter is an integration seam, not public-network-ready P2P transport; external exposure requires TLS, production identity integration and review.

## 0.32.34 — Persistent social identity directory
- Added proof-of-possession profile registration bound to Ed25519 signing keys and X25519 encryption public keys.
- Derived stable `zion:<sha256>` identity identifiers from signing public keys; usernames are unique labels, not claims of real-world identity.
- Added bounded listing, lookup by identity or username, atomic persistent writes, restart validation, and private-key exclusion from returned profiles.
- Added tests for proof tampering, duplicate usernames, idempotent registration, persistence, and invalid stored records.
- This is a local directory primitive; it does not provide global consensus, Sybil resistance, key recovery/rotation, or network-wide discovery.

## 0.32.38 — Inactivity policy scheduler

- Added a lifecycle-managed interval scheduler for inactivity policy evaluation, with single-flight protection against overlapping ticks, explicit start/stop, a status snapshot, and bounded error reporting.
- Serialized authenticated activity handling behind an in-flight evaluation so stale inactivity decisions cannot complete after the activity reset.
- Added deterministic tests for lifecycle, coalescing, error handling, activity ordering, and invalid configuration.
- Documented the adapter contract and deployment requirements. Real storage/notification adapters and application startup wiring are still required; this release does not claim live UI or production deployment integration.

## 0.32.40 — inactivity scheduler lifecycle integration

- `OfficialNodeBootstrap` can now own an optional inactivity scheduler, starting it only after integrity checks, storage startup, and transport binding succeed.
- Scheduler shutdown is requested before transport/storage cleanup during rollback, quarantine, and graceful close.
- Startup reports whether inactivity scheduling is configured; the scheduler remains opt-in and requires real host-provided policy/storage/notification adapters.
- Added lifecycle tests for startup ordering, shutdown ordering, invalid adapters, and fail-closed integrity startup.

## 0.32.41 — local inactivity settings preview

- Replaced the static inactivity-policy description in Cloud settings with editable pause and capacity-reduction deadlines and a live impact preview.
- Added validated browser-local persistence, explicit reset-to-default behavior, accessible feedback, and safe handling when browser storage is unavailable or contains invalid data.
- The UI labels these values as local preview settings and explicitly states they are not sent to or applied on a real node.
- Added eight tests for defaults, deadline ordering, percentage bounds, persistence, invalid storage, truthful preview status, and accessible page wiring.

## 0.32.42 — authenticated inactivity settings service

- Added per-identity settings storage bound to `SocialSessionAuthority` authenticated sessions.
- Added strict schema and threshold validation, safe atomic persistence, serialized writes, scoped reset, and conversion to policy duration options.
- Added tests for authentication, isolation between identities, restart persistence, invalid inputs, concurrent updates, and policy option conversion.
- Explicitly reports that saved preferences are not automatically applied to a running node; transport/API and UI integration remain host responsibilities.

## [0.32.43] - 2026-10-09

### Added
- Authenticated HTTP API for per-identity inactivity settings (`GET`, `PUT`, `DELETE`).
- Strict JSON content type and 8 KiB body limit, request rate limiting, no-store/security headers, and loopback-only default binding.
- API tests for auth, identity isolation, validation, oversized/invalid bodies, method restrictions, rate limits, and remote-bind guard.
- API integration and deployment-security documentation.

### Security notes
- Remote binding requires explicit opt-in and must sit behind a trusted TLS ingress. The adapter does not provide TLS itself.
- Settings responses continue to declare `appliedToNode: false`; runtime enforcement remains a separate integration task.

## [0.32.48] - 2026-10-09

### Added
- Added a Cloud notification center with delivery-state filters, explicit refresh, unread indicators, and owner-session-backed mark-as-viewed actions.
- Integrated the optional authenticated notification API client into the existing Cloud authentication provider without persisting access tokens.
- Added responsive styles and accessible status feedback; when authentication/API wiring is absent, the panel clearly explains that live history is unavailable and does not fabricate notifications.
- Added API client and Cloud preview regression tests.

### Limitations
- The Cloud page consumes the notification API only when `window.ZionAuth.getAccessToken` and a reachable host API are supplied. This release does not deploy the API, provision authentication, or add push/email delivery.

## [0.32.59] - Crash-window delivery fencing
- Persist dispatch intent before calling an external notification provider.
- Convert an expired claim with a durable dispatch marker into an ambiguous outcome instead of automatically resending after a process crash.
- Treat provider exceptions after dispatch begins conservatively; persist ambiguity when a returned receipt cannot be durably recorded.
- Clear dispatch markers only on a durable terminal transition or a contractually explicit non-delivery result.
- Added restart and receipt-persistence regression tests.

## [0.32.70] - 2026-10-09

### Added
- Added a side-effect-free notification recovery reconciliation report that compares pre-recovery and restored delivery states.
- Reports records missing after restore, regressions from delivered to non-delivered states, provider-evidenced delivery/non-delivery, and unresolved outcomes.
- Enforces owner-scoped record identity, input bounds, unique provider evidence, and a receipt requirement for provider-confirmed delivery.
- Explicitly performs no retries and mutates no input records; notification message bodies are omitted from the report.

### Limitations
- The reconciliation module is a report builder, not a provider connector. Callers must obtain trustworthy provider evidence and pass minimal records from a controlled source. A provider receipt string is only as trustworthy as the adapter supplying it.

## [0.32.71] - 2026-10-09

### Added
- Added `NotificationRecoveryCasebook`, a local append-only casebook for durable reconciliation reports.
- Publishes unique case files with exclusive hard-link creation, restrictive file permissions, file and directory synchronization, and duplicate-case protection.
- Verifies report SHA-256 on read, rejects symlink entries, and provides integrity-checked listing.
- Accepts only read-only/no-retry reports and rejects reports that claim resend side effects or mutated records.

### Limitations
- The casebook is a local integrity-checked record, not a cryptographically signed or tamper-proof audit service. A privileged actor able to rewrite both a report and its digest can forge the entry. Multi-host consensus and provider receipt verification remain separate integration tasks.

## 0.32.73 — Signed Recovery Decisions

- Added `NotificationRecoverySignedDecisionStore` with Ed25519 signatures bound to the exact reconciliation case digest.
- Verifies trusted key match before signing, enforces explicit key revocation, unique decision IDs, bounded expiry (up to 24 hours), and append-only exclusive publication.
- Verifies signature, digest, expiry, revocation status, and current case digest when reading decisions.
- Signed decisions record that no delivery action was executed; this module does not perform retries.
- Added tests for valid signatures, key mismatch, stale reports, duplicate IDs, tampering, expiration, revocation, and stale-case invalidation.

## 0.32.74 — Persistent Recovery Trust Registry

- Added `NotificationRecoveryTrustRegistry` with durable local key trust, permission allowlisting, explicit revocation, revisioned audit events, atomic replacement, restrictive file permissions, and SHA-256 corruption detection.
- Integrated signed recovery decisions with the live registry so revocations take effect without recreating the decision store and remain effective after restart.
- Prevented key-ID rebinding and reactivation of revoked key IDs; rotation requires a new key ID.
- Added tests for persistence, dynamic revocation, permission rejection, tampering, and symbolic-link refusal.
- The registry digest detects accidental or unsophisticated edits; it is not a signature and does not protect against a filesystem administrator who can rewrite both state and digest. Cross-process concurrent administration is not claimed.

## [0.32.77] - Independent Anchor Adapter Boundary

- Added an adapter-based interface for publishing and retrieving signed recovery audit checkpoints from a separately operated destination.
- Added signature verification before publication, read-back verification, idempotent publication, ancestry/rollback conflict checks, and explicit unavailable-destination results.
- Added a memory adapter for tests only; it is not a production independent trust domain.
- Added tests for valid publication, forged checkpoints, rollback/forks, destination outages, and tampered read-back.

## [0.32.78] — 2026-10-09

- Added `PersistentFileNotificationAnchor`, a durable file-backed checkpoint adapter with atomic replacement, restrictive file modes, directory/file fsync, and inter-process exclusive locking.
- Enforced checkpoint progression while holding the lock; identical publication is idempotent, forks/rollback are rejected, and existing locks are never stolen automatically.
- Added restart-persistence, concurrent idempotent publish, lock-timeout, symlink rejection, and conflicting checkpoint tests.
- Security note: file-backed storage is an independent trust anchor only when the destination directory is independently administered; colocating it with the registry does not create an independent trust domain.

## [0.32.81] - Interrupted-write recovery checks

- Added recovery coverage for orphaned temporary checkpoint files left before atomic rename.
- Confirmed temporary files are not mistaken for committed state and are preserved for forensic inspection.
- Added a corruption test proving malformed committed checkpoint data blocks publication rather than being silently overwritten.
- This release does not automatically clean temporary files or stale locks; safe cleanup remains an operator action after investigation.


## [0.32.82] - Process-crash temporary recovery

- Added an independent child-process crash test that writes and fsyncs a partial temporary checkpoint, then exits abruptly.
- Verified the partial file is ignored as uncommitted state, remains available for forensic inspection, and does not prevent a subsequent valid atomic publication.
- This test exercises process termination, not machine power loss or physical-device durability.

## [0.32.84] — Lock-release failure semantics

- Changed publication cleanup so lock-release failures cannot silently replace the original publication error.
- When both publication and lock release fail, the adapter raises an `AggregateError` retaining the primary failure as `cause` and the cleanup failure as a second error.
- Added deterministic tests for successful publication with failed lock cleanup and for simultaneous checkpoint conflict plus lock cleanup failure.
- Added a private `_unlinkSync` injection seam for deterministic cleanup-failure testing.

## [0.32.83] — Durability uncertainty recovery

- Made identical-checkpoint retries explicitly fsync the committed checkpoint and its parent directory before reporting idempotent success.
- Added a deterministic injected directory-fsync failure test: publication reports `NOTIFICATION_ANCHOR_DURABILITY_UNCONFIRMED` after atomic rename, leaves the visible checkpoint intact, and a retry re-confirms file and directory durability before returning idempotent success.
- The injected failure is a control-flow regression test, not a physical power-loss or storage-device certification.


## 0.32.85 — Lock Ownership Verification

- Lock records now include a random ownership token and the acquired file descriptor identity.
- Lock cleanup verifies token and inode identity before unlinking; a replaced lock is preserved and reported as `NOTIFICATION_ANCHOR_LOCK_OWNERSHIP_LOST`.
- Lock initialization errors fail closed and leave any uncertain lock state for operator inspection rather than blindly unlinking the path.
- Added an injected out-of-band lock-replacement test.

This reduces accidental removal of a replaced lock but does not protect against a privileged actor or guarantee atomic conditional unlink on every filesystem. Operators must not remove lock files while publishers may be active.

## 0.32.86 — Read-only anchor diagnostics

- Added `inspectPersistentAnchorState()` and `npm run anchor:diagnose -- <anchor-path>` for a read-only report of checkpoint structure, lock presence/ambiguity, and orphaned temporary artifacts.
- Diagnostics open checkpoint and lock files without following symlinks where the platform supports `O_NOFOLLOW`, and never reclaim locks or delete temporary evidence.
- Reports a readable checkpoint as `visible_checkpoint` with `historical_durability_unknown`; it does not claim that past fsync completion or rollback resistance can be inferred from local files.
- Added tests for empty state, visible checkpoint plus ambiguous lock and orphaned temporary file, and malformed checkpoint/symlink lock.

## 0.32.87 — Signed Checkpoint Chain Verification

- Added a read-only verifier for ordered checkpoint histories.
- Verifies each Ed25519 signature, signer identity, freshness policy, ancestry links, and strictly advancing registry revisions.
- Supports anchoring a supplied history to a previously trusted checkpoint.
- Reports the failing checkpoint index and number of verified checkpoints without mutating evidence.
- Explicitly documents that a latest-only checkpoint cannot prove omitted history or independently prevent rollback.

## 0.32.88 — Integrated signed-chain diagnostics

- Integrated the signed checkpoint-chain verifier into the read-only persistent-anchor diagnostic report.
- Added optional history JSON and public PEM inputs, expected signer identity, and a maximum checkpoint age policy.
- Reports `not_checked` when verification inputs are absent/incomplete; reports invalid signatures, broken history, and latest-anchor mismatch as `attention_required`.
- Keeps diagnostics read-only: it does not repair state, reclaim locks, or remove temporary artifacts.
- Added tests for a verified signed history, a validly signed but mismatching latest checkpoint, incomplete verification inputs, and evidence non-mutation.

## 0.32.89 — Explicit external anchor-key trust policy

- Added a versioned trust-policy format binding an Ed25519 signer ID to a public key and SHA-256 fingerprint of its DER SubjectPublicKeyInfo.
- Integrated `--trust-policy` into read-only chain diagnostics; the signer ID and key are taken from the policy rather than separately supplied CLI values.
- Rejects malformed policies, invalid key types, and fingerprint mismatches as untrusted; trust-policy files are opened using the existing no-follow regular-file checks.
- Documents that the policy must be provisioned or pinned out-of-band. A fingerprint stored beside its own key is an integrity consistency check, not proof of identity; signed key rotation and remote freshness witnesses remain unimplemented.
- Added tests for successful trust-policy verification, fingerprint mismatch, and read-only evidence preservation.

## 0.32.90 — Signed anchor-key rotation chain

- Added explicit Ed25519 key-rotation transition records signed by the currently trusted key, binding old/new key IDs, the next public key and its DER-SPKI SHA-256 fingerprint.
- Added ordered rotation-chain verification anchored in the externally provisioned v1 trust policy; each transition must link to the prior transition hash and the previous active signer.
- Rejects invalid signatures, broken links, future/stale transitions, fingerprint mismatches, malformed records, and reused key IDs (including attempts to cycle back to an earlier identity).
- Added tests for valid single/multiple rotations and tampering, chain breaks, stale transitions, and key-ID reuse.
- Rotation verification is a library API in this release; it does not yet change the checkpoint-diagnostics CLI. Key revocation is represented by rotating to a new key, not by a separate revocation protocol. The initial trust policy still requires independent out-of-band provisioning.


## 0.32.93
- Integrated signed key-revocation verification into read-only persistent-anchor diagnostics.
- Require revocation history and an independently provisioned authority public key together.
- Reject checkpoint-chain verification when the effective signer is present in verified revocation evidence.
- Added regression coverage for revoked signers, incomplete revocation inputs, and evidence preservation.

## 0.32.94
- Added an Ed25519-signed independent freshness witness bound to the exact checkpoint-history head and monotonic sequence.
- Added fail-closed verification for stale/future witnesses, key-ID mismatch, signature tampering, head mismatch, and sequence rollback below an externally supplied floor.
- The freshness witness is currently a library API; operational diagnostics integration and durable anti-rollback state remain follow-up work.

## 0.32.97

- Added Ed25519 nonce-bound remote witness challenge/response primitives for freshness checks.
- Integrated challenge-response evidence into read-only anchor diagnostics using an independently provisioned witness public key, expected nonce, history-head binding, sequence floor, and freshness window.
- Added tests for successful verification, nonce replay, expiry, history-head mismatch, tampering, and sequence rollback.
- The caller must generate a fresh cryptographically random challenge for every check; this release does not implement remote transport or durable nonce/sequence storage.
- Added `anchor:create-witness-challenge` CLI to emit a fresh nonce bound to the supplied non-empty checkpoint history without modifying evidence.


## v0.33.3 — TLS transport hardening

- Added HTTPS serving via `ZION_WITNESS_TLS_CERT` and `ZION_WITNESS_TLS_KEY`.
- Rejects non-loopback HTTP binds at startup to prevent accidental plaintext exposure.
- Rejects incomplete TLS configuration.
- Retains authenticated requests, per-process rate limiting, durable nonce replay protection, and state locking.

## [0.33.4] - Remote witness client

- Added `scripts/request-remote-witness.js` to issue one-use freshness challenges directly to a remote witness service.
- Verifies witness identity, key identity, Ed25519 signature, nonce, exact history-head hash, challenge expiry, and response freshness before saving evidence.
- Restricts plaintext HTTP to loopback, disallows redirects, bounds response size, rejects symlink input files, and writes evidence without overwriting existing files.
- Added `anchor:request-witness` npm command.

## Zion v0.33.5 — Shared rate limits across processes

- Replaced per-process in-memory request counters with a shared, atomically persisted rate-limit state file (`<ZION_WITNESS_STATE>.rate-limits.json`).
- Serializes updates with a dedicated lock separate from the witness sequence lock, so concurrent service processes share one IP/client quota.
- Persists state with restrictive file permissions, fsync and atomic rename; fails closed with HTTP 503 when shared limiter state or its lock is unavailable.
- Retains a bounded set of active keys and expires old windows.
- Added a multiprocess integration test proving a second process receives HTTP 429 after the shared quota is consumed.


## 0.33.6 — Operational audit hardening

- Restrict witness audit records to a strict field allowlist; arbitrary fields, credential values, request headers, paths, and exception messages are excluded.
- Add an integration test proving successful authentication produces structured audit events without leaking the bearer token.
- Preserve shared persistent rate limits and fail-closed behavior from v0.33.5.

### Zion v0.33.7 — Witness end-to-end verification
- Added a live end-to-end test covering the remote witness service, authenticated client challenge, signed evidence persistence, and read-only freshness diagnostics.
- Confirms the saved response is bound to the exact signed checkpoint history head and is accepted only after independent public-key verification.
- This release adds test coverage; it does not claim production deployment or distributed coordination across independent hosts.

## 0.33.17 — Witness crash-boundary publication regressions

- Added subprocess crash injection immediately before and after the atomic hard-link commit point.
- Added a directory-fsync failure regression: the command reports failure/uncertain durability but preserves already-visible evidence rather than rolling it back.
- Verified that a hard kill before commit leaves no destination, while a hard kill after commit leaves complete evidence and may leave a temporary hard-link alias.
- These are process-crash simulations on a local filesystem, not power-loss or hardware durability certification.

## [0.33.23] - 2026-10-10

### Added
- Optional durable local trust-state pin for trusted checkpoint history verification (`--state-file`).
- Monotonic revision, same-revision head hash, and timestamp rollback detection against previously persisted state.
- Atomic state replacement with file and directory fsync, restrictive file mode, and exclusive lock; ambiguous or corrupt state fails closed.

### Security boundaries
- The state file and its parent directory must be protected independently from the history being verified. If an attacker can roll back or replace both, this local pin cannot establish anti-rollback guarantees by itself.
- The exclusive lock deliberately fails closed when present; stale lock recovery is manual to avoid unsafe automatic lock stealing.

## [0.33.25] - 2026-10-10

### Added
- Ed25519-signed external trust-anchor receipts binding authority ID, monotonic sequence, checkpoint revision, and exact checkpoint SHA-256.
- Bounded freshness window and expiry checks with explicit minimum-sequence enforcement to detect receipt rollback when the sequence pin is independently maintained.
- `anchor:verify-external-trust-receipt` CLI with bounded regular-file reads, symlink refusal where supported, and before/after metadata checks.
- Adversarial tests for signature tampering, authority/head mismatch, sequence rollback, stale/expired/future receipts, malformed input, and wrong key type.

### Security boundaries
- This verifier is offline and does not contact the authority. Freshness depends on the local clock and receipt expiry.
- Operators must obtain the authority public key independently and persist `minimumSequence` in a trust domain that an attacker cannot roll back with local history.
- This feature verifies a receipt; it does not create a transparency service or prove that an authority is honest, available, or globally consistent.

## [0.33.26] - Content admission and governance controls

- Added local-only SHA-256 blacklist screening before encryption/fragmentation; CLI emits only a decision and byte count, not the content hash.
- Added signed uploader attribution manifests with CID binding, nonce, timestamp checks, and Ed25519 verification.
- Added signed, expiring gateway moderation decisions and an in-memory CID pointer filter.
- Added an in-memory stake accounting primitive that only releases or slashes after an explicitly authorized governance adjudication and supports key bans.
- Added adversarial tests for blacklist matches, malformed hashes, signatures, CID mismatch, stale/expired decisions, wrong authorities, duplicate stake IDs, unauthorized adjudication, and repeat adjudication.
- Explicit limitations: exact-hash screening is not a zero-knowledge proof; gateway registry and stake ledger are in-memory reference components, not distributed consensus or token custody; no legal conclusion is implied.

## [0.33.27] - Invisible consumer client facade

- Added `ZionClient` with a simple `upload()` / `download()` interface so consumer apps need not orchestrate screening, chunking, encryption, content addressing, and integrity checks themselves.
- Encrypts each chunk client-side with AES-256-GCM; storage adapters receive ciphertext only, while the file key stays with the caller and is excluded from the manifest.
- Adds canonical manifest CID validation, chunk bounds/order checks, ciphertext integrity checks, gateway moderation enforcement on download, explicit deletion, and best-effort cleanup after upload failure.
- Added `MemoryCiphertextAdapter` and a consumer-client demo for local testing; it is not a production network adapter.
- Explicitly does not claim ZKP, automatic key distribution, distributed transactions, production deployment, or legal `common carrier` status.


## [0.33.28] - Signed Witness temporary recovery

- Added Ed25519-signed `.meta` sidecars binding publisher ID, session nonce/timestamp, token ID, lifecycle state, fsync assertion, destination, byte length, and SHA-256 target hash.
- Added fail-closed orphan discovery: only signed, unexpired, session-valid `READY_FOR_COMMIT` items are eligible for recovery.
- Added atomic no-replace hard-link commit, destination conflict quarantine, orphan/sidecar quarantine, and fsynced JSONL audit events.
- Added tests for recovery/idempotence, invalid signatures, revoked sessions, hash tampering, incomplete metadata, destination conflicts, and path traversal.
- Limitation: caller-provided session validation must enforce token revocation and durable nonce replay prevention; this is a local filesystem primitive, not distributed consensus.


## [0.33.31] - 2026-10-10

### Added
- Added `stageWitnessTemporary()` as the publisher-side durable staging primitive consumed by the signed recovery path.
- Writes staging bytes with exclusive creation and restrictive permissions, fsyncs the data before asserting `fsynced: true`, then writes and fsyncs the signed sidecar and staging directory.
- Returns explicit staging paths and content metadata; publication remains a separate no-replace recovery/commit operation.
- Added tests for helper-to-recovery end-to-end behavior and rejection of staging paths outside the configured data root.

### Security boundaries
- The helper is a local filesystem primitive; callers must still validate active Witness sessions, provision publisher keys securely, and protect the root directory from untrusted writers.
- Directory fsync and hard-link semantics depend on the underlying filesystem/platform. The helper does not claim distributed locking or power-loss guarantees beyond the OS/filesystem contract.
