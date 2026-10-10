# Zion v0.33.20 — Offline Witness evidence verification audit

## Scope

Built on v0.33.19. Added `anchor:verify-witness-evidence`, a read-only verifier for saved remote Witness challenge responses. It checks the Ed25519 signature, expected Witness ID and key ID, minimum sequence, signed challenge-window consistency, and binding to the head hash computed from a supplied checkpoint-history file.

The verifier uses no-follow regular-file reads with bounded sizes and before/after metadata checks. It rejects symlinks/non-regular files, oversized inputs, and detected concurrent changes. It never modifies evidence or history.

## Verification performed

- `node --test test/verify-witness-evidence.test.js`: 5 passed, 0 failed.
- `npm test`: 481 passed, 0 failed.
- `npm run check`: syntax check passed for 147 JavaScript files.
- `npm run demo`: exit code 0; unavailable telemetry continued to produce zero budgets.
- ZIP integrity and SHA-256 checked after packaging.

## Regressions

- Valid Ed25519-signed evidence passes with expected identity, minimum sequence, and matching history head.
- Tampered signature is rejected.
- Wrong expected Witness identity and minimum-sequence rollback are rejected.
- A different checkpoint-history head is rejected.
- Symlink evidence and evidence exceeding the bounded input limit are rejected.

## Important limits

This is offline signature-and-binding verification, not proof of current freshness or anti-replay. The nonce is part of the signed response, but without an independently retained challenge record or a new online challenge, an offline verifier cannot establish that it is fresh now. The command computes a head hash from the supplied checkpoint history but does not independently verify every checkpoint signature, checkpoint-chain continuity, or external trust-registry status. Use the live challenge flow and trusted operational policy for current freshness and trust decisions.

No automatic recovery, deletion, promotion, overwrite, GitHub publication, or production deployment was performed. Tests do not simulate power loss, kernel crashes, storage-controller cache loss, or certify network/distributed filesystem behavior.

## Reproduce

```sh
node --test test/verify-witness-evidence.test.js
npm test
npm run check
npm run demo
npm run anchor:verify-witness-evidence -- <evidence.json> <public-key.pem> <history.json> <witness-id> <key-id> [minimum-sequence]
```
