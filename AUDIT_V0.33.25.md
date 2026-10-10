# Zion v0.33.25 — External trust-anchor receipt verification

## Scope

Adds an offline verifier for a signed receipt issued by an independently operated trust authority. The receipt binds authority identity, sequence, revision, checkpoint hash, issue time, and expiry under Ed25519.

## Security properties

- Rejects malformed receipts, non-Ed25519 public keys, invalid signatures, unexpected authority IDs, wrong checkpoint revision/hash, sequence rollback below an externally configured minimum, future-issued receipts, expired receipts, and receipts older than the configured maximum age.
- CLI input reads are bounded to regular files, refuse symlinks where `O_NOFOLLOW` is supported, and compare descriptor metadata before and after reading.
- Verification is read-only; it does not contact the external authority or mutate local trust state.

## Security boundaries

- This does not implement an online transparency service or prove authority honesty/global consistency.
- Freshness depends on the local system clock and signed expiry.
- The `minimumSequence` must be pinned independently to detect replay across restarts. If an attacker can roll back that pin as well as local history, local verification cannot detect the coordinated rollback.
- The authority public key must be authenticated out of band.

## Validation

- `npm test`: 500 passed, 0 failed.
- `npm run check`: passed for 157 JavaScript files.
- `npm run demo`: exit code 0.
- ZIP archive integrity and SHA-256 were checked after packaging.
