# Verified PostgreSQL admission boundary

`VerifiedPostgresPeerAdmissionService` verifies voucher signatures, expiry, subject binding, trusted issuer membership, and distinct issuer identities before invoking `PostgresPeerAdmissionStore.commitAdmission()`. It only submits issuer IDs and nonces extracted from verified vouchers.

The transport/bootstrap entry point must call this service rather than the raw store. The PostgreSQL transaction enforces mutable invariants including subject uniqueness, nonce consumption, issuer quotas, policy limits, and capacity reservations. Storage-headroom metrics fail closed when unavailable; they do not constitute remote physical-storage reservations.

This boundary does not automatically replace existing `PeerAdmissionController` call sites. Transport wiring, durable reconciliation after ambiguous commits/restarts, database restore testing, and migration/backup operational validation remain production gates.
