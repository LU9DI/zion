# Zion v0.33.24 — Persistent trust-state diagnostics audit

## Scope

Adds a strictly read-only diagnostic for the local monotonic trust-state pin introduced in v0.33.23 and its exclusive lock file.

## Changes

- `scripts/diagnose-trusted-history-state.js` inspects state and lock with bounded regular-file reads, `O_NOFOLLOW` where supported, and before/after metadata comparisons.
- Validates schema and SHA-256 checksum of the canonical JSON body for state version 1.
- Reports lock PID liveness as advisory only. A PID that is not running on the local host suggests a possible abandoned lock but does not authorize automatic removal.
- Emits explicit operator guidance and never deletes, renames, repairs, or overwrites trust-state artifacts.
- Added `npm run anchor:diagnose-trusted-state -- <state-file>` and four focused tests.

## Validation performed

- Full test suite: 495 passed, 0 failed.
- `npm run check`: passed for 154 JavaScript files.
- `npm run demo`: exit code 0.
- ZIP integrity and SHA-256 are verified after packaging.

## Security boundaries

- This command is diagnostic only. PID probes may be ambiguous due to PID reuse, permissions, containers, or namespaces; never automatically delete locks based on this output.
- It does not protect against an attacker who can restore both the local trust state and checkpoint history, and does not establish remote freshness.
- No GitHub publication or production deployment was performed.
