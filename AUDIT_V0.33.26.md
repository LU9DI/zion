# Zion v0.33.26 — Content Admission & Governance Controls Audit

## Scope

This release adds a local content-hash screening primitive, signed uploader attribution manifests, signed gateway CID moderation decisions, and an in-memory stake-accounting reference component.

## Security properties

- Local screening computes SHA-256 before encryption/fragmentation and compares it to a configured list. The CLI prints only accepted/rejected status, reason, and byte count; it does not print the digest or transmit the content.
- Signed attribution manifests bind a CID, content digest, uploader public key, timestamp, and nonce using Ed25519. Verification checks signature, expected CID, age, and future clock skew.
- Gateway moderation decisions are signed, scoped to an authority ID, time-bounded, and limited to `block` / `unblock` actions. Invalid, expired, or wrong-authority decisions are rejected.
- Stake accounting rejects duplicate upload IDs, invalid amounts, unauthorized adjudications, repeat adjudication, and new holds from keys banned by a prior slash-and-ban outcome.

## Validation

`npm test`: 511 passed, 0 failed. `npm run check`: syntax passed for 161 JavaScript files. `npm run demo`: exit code 0. These are local checks only; do not infer production deployment from them.

## Important limitations

- Exact SHA-256 blacklist screening is **not a zero-knowledge proof**. The digest can be vulnerable to dictionary/fingerprint attacks if shared. The provided CLI keeps the digest local, but callers must not transmit it casually.
- This module does not implement a ZK circuit, proof system, public blacklist accumulator, or proof verifier. A future ZKP design needs a defined threat model, circuit review, trusted-setup analysis where relevant, and independent cryptographic audit.
- Blacklist quality, provenance, update freshness, false positives, appeal mechanisms, and lawful governance remain external responsibilities.
- The gateway registry and stake ledger are in-memory reference implementations. They are not persistent, replicated, Byzantine fault tolerant, blockchain-backed, or suitable for custody of real tokens without additional engineering.
- A `slash-and-ban` action is only accepted after a caller asserts an authorized governance adjudication. Production deployment must replace this trust boolean with cryptographically verified, replay-protected adjudication records and an appeal/oversight process.
- Uploader signatures provide attribution to a key, not proof of a person's legal identity or a determination of legal responsibility. The software does not establish a `common carrier` legal status.
- Moderation blocks a pointer at the gateway; it cannot guarantee deletion of encrypted fragments already replicated elsewhere.
- No GitHub release or production deployment is performed by this package operation.

## CLI smoke checks

- Clear input with an empty local blacklist: accepted; output contained decision/reason/byte count and did not print the digest (exit 0).
- Input whose SHA-256 was in the local blacklist: rejected with `blacklisted-hash` (exit 1); the CLI did not print the digest.
