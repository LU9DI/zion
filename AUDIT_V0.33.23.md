# Zion v0.33.23 — Persistent trust-state pin audit

## Scope

Adds an optional local monotonic pin to the existing offline trusted checkpoint-history verifier. The pin is updated only after the complete chain, rotation, revocation, and optional rollback policy checks succeed.

## Changes

- `scripts/persist-trusted-history-state.js`: persists schema-versioned head revision, checkpoint SHA-256, and issuance timestamp with a canonical JSON-body checksum.
- Rejects lower revisions, same-revision/different-hash forks, and head timestamps moving backwards.
- Uses an exclusive `.lock` file, mode `0600`, bounded regular-file reads, no-follow opening where supported, temporary-file creation, file fsync, atomic rename, and parent-directory fsync.
- Existing corrupt/unreadable state and a pre-existing lock fail closed; automatic stale-lock stealing is intentionally not implemented.
- CLI supports `--state-file <path>`; optional rollback policy remains supported.
- README, CHANGELOG, and four focused tests added.

## Validation performed

- Full test suite: 491 passed, 0 failed.
- `npm run check`: passed for 152 JavaScript files.
- `npm run demo`: exit code 0.
- ZIP integrity and SHA-256 verified after packaging.

## Security boundaries

- This is a local anti-rollback pin, not a hardware-backed monotonic counter. Protect the state file and its parent directory independently from checkpoint bundles.
- An attacker who can restore both the state file and the checkpoint history to an older pair can bypass this local mechanism. A remote transparency service or hardware-backed monotonic storage is required for stronger guarantees.
- A leftover lock fails closed and requires operator investigation. Do not remove it without confirming no writer remains active.
- Filesystem durability semantics vary by OS and filesystem; successful fsync does not prove physical-media persistence under every failure mode.
- No GitHub publication or production deployment was performed.
