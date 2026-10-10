# Zion v0.33.21 — Trusted checkpoint-chain verification audit

## Scope

This release adds a read-only offline verifier for a complete checkpoint history, resolving checkpoint signer keys from an out-of-band initial trust policy and signed key-rotation transitions, then checking revocation events signed by a separately supplied revocation authority. It does not change the existing saved-Witness-evidence verifier.

## Implementation

- `scripts/verify-trusted-checkpoint-history.js`: validates the initial Ed25519 key fingerprint, full rotation chain, full revocation chain, each checkpoint signature, signer authorization, chain start/linkage, and advancing revisions.
- `scripts/verify-trusted-checkpoint-history-cli.js`: bounded input reads, no-follow open where supported, regular-file checks, and before/after metadata comparison.
- `test/verify-trusted-checkpoint-history.test.js`: successful rotated chain, broken/tampered chain, truncated history, invalid rotation, unknown signer, and revocation rejection.
- `package.json`: version `0.33.21`, command `anchor:verify-trusted-history`.
- README and CHANGELOG updated with usage and limitations.

## Validation performed

- Targeted tests: 4 passed, 0 failed.
- Full test suite: 485 passed, 0 failed.
- `npm run check`: passed for 150 JavaScript files.
- `npm run demo`: exit code 0. Demo output notes telemetry is unavailable; this is expected for the demo's optional telemetry path.
- Archive SHA-256 is recorded in the adjacent `.sha256` file.

## Security boundaries and limitations

- Initial trust policy and revocation-authority public key must be provisioned and authenticated out of band. A bundle supplied entirely by an untrusted party cannot bootstrap its own trust.
- This is offline verification. It cannot prove that the supplied rotation/revocation bundle is the latest authoritative state, nor prevent replay of an old but internally consistent bundle without an independently enforced freshness policy.
- The verifier requires a complete chain beginning at a checkpoint whose predecessor is `null`; it does not support an omitted prefix anchored by a trusted checkpoint in this CLI.
- Any signer listed as revoked is rejected for checkpoint use in the supplied history; active signer revocation also fails the whole verification.
- Filesystem no-follow flags and metadata checks reduce, but do not eliminate, all race conditions on every OS/filesystem. No claims are made about power-loss behavior or physical-media integrity.
- No files are changed by the verification command. No GitHub release, external publication, or production deployment was performed.
