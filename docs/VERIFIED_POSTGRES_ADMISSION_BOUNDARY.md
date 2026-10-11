# Verified PostgreSQL admission boundary

`VerifiedPostgresPeerAdmissionService` verifies voucher signatures, expiry, subject binding, trusted issuer membership, and distinct issuer identities before invoking `PostgresPeerAdmissionStore.commitAdmission()`. It only submits issuer IDs and nonces extracted from verified vouchers.

Use `createOfficialPostgresAdmissionTransport()` from `src/official-postgres-admission-transport.js` to compose the official `PeerTransport` with the verified service and transactional store. Pass the returned `transport` to `OfficialNodeBootstrap`; do not inject the raw store into the transport. The factory fixes the security-critical transport options and prevents a caller from replacing the admission controller through `transportOptions`. `OfficialNodeBootstrap.start()` now invokes the admission service's `verifyPersistentState()` before storage startup or listener binding. This startup preflight locks policy/capacity rows, validates policy values, checks active-row/reservation-count equality, and checks active admissions have matching issuer and consumed-invitation evidence. It does not apply migrations or provision trust material. This remains an explicit composition helper, not an automatic replacement of existing application entry points.

The PostgreSQL transaction enforces mutable invariants including subject uniqueness, nonce consumption, issuer quotas, policy limits, and capacity reservations. Storage-headroom metrics fail closed when unavailable; they do not constitute remote physical-storage reservations.

An ambiguous `COMMIT` is never automatically replayed. The store marks the affected subject unavailable until `isAdmitted()` successfully queries PostgreSQL; because the transaction is atomic, that authoritative row resolves whether admission committed. Other subjects are not globally blocked by one ambiguous result. A restarted process has a fresh in-memory ambiguity marker, so callers must query authoritative admission state before retrying an invitation and must not infer absence from a prior process's error.

## Deployment requirements still open

- Provision the PostgreSQL pool, reviewed genesis, bootstrap peer allowlist, and trusted issuer IDs through deployment-controlled configuration.
- Apply and validate `migrations/postgres/0001_peer_admission.sql` before opening the listener.
- Exercise real PostgreSQL restart, crash-after-COMMIT, restore, and migration rollback/recovery drills; the existing integration suite runs only when `ZION_POSTGRES_TEST_URL` is configured.
- Integrate this factory into the actual deployment entry point and ensure no official-mode path constructs `PeerTransport` with the in-memory admission controller or without an admission controller.
- Define operational handling for policy changes, capacity reconciliation, backup/restore, and stale active admission rows.
- Follow [`VERIFIED_POSTGRES_ADMISSION_DEPLOYMENT_RUNBOOK.md`](./VERIFIED_POSTGRES_ADMISSION_DEPLOYMENT_RUNBOOK.md) for preflight, correctness checks, failure drills, go/no-go criteria, and evidence capture.

This change provides a tested composition helper and transaction boundary, but it does not by itself certify a production deployment. Keep PR #33 in draft until the remaining deployment and recovery gates are evidenced.
