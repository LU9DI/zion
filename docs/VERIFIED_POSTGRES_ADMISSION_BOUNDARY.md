# Verified PostgreSQL admission boundary

`VerifiedPostgresPeerAdmissionService` verifies voucher signatures, expiry, subject binding, trusted issuer membership, and distinct issuer identities before invoking `PostgresPeerAdmissionStore.commitAdmission()`. It only submits issuer IDs and nonces extracted from verified vouchers.

The transport/bootstrap entry point must call this service rather than the raw store. The PostgreSQL transaction enforces mutable invariants including subject uniqueness, nonce consumption, issuer quotas, policy limits, and capacity reservations. Storage-headroom metrics fail closed when unavailable; they do not constitute remote physical-storage reservations.

An ambiguous `COMMIT` is never automatically replayed. The store marks the affected subject unavailable until `isAdmitted()` successfully queries PostgreSQL; because the transaction is atomic, that authoritative row resolves whether admission committed. Other subjects are not globally blocked by one ambiguous result. A restarted process must still query authoritative admission state before retrying an invitation.

This boundary does not automatically replace existing `PeerAdmissionController` call sites. Transport/bootstrap wiring, process-restart and database restore drills, and migration/backup operational validation remain production gates.
