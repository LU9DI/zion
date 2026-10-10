# Zion v0.33.31 — Signed Witness Staging Integration Audit

Date: 2026-10-10

## Scope

This release adds a publisher-side staging primitive to the signed Witness temporary recovery mechanism. `stageWitnessTemporary()` writes bytes with exclusive creation and mode `0600`, fsyncs the data file before setting the signed `fsynced: true` assertion, signs metadata with Ed25519, writes the sidecar exclusively, and fsyncs the staging directory before returning. The existing recovery path validates the sidecar, publisher key, session callback, timestamp bounds, replay ledger, content length/hash, and safe destination before using an atomic no-replace hard-link commit.

## Validation performed

- `npm test`: **533 passed, 0 failed**.
- `node scripts/check-syntax.js`: passed for 166 JavaScript files.
- `npm run demo`: exit code 0.
- `npm run client:demo`: exit code 0; output reports seven encrypted chunks and ciphertext-only adapter storage.
- ZIP integrity checked with `unzip -t`.

New tests cover the end-to-end staging-helper-to-recovery path and rejection of a staging directory outside the data root. Existing tests cover signatures, revoked sessions, content tampering, path traversal, idempotence, `SIGKILL` recovery, concurrent recovery processes, replay ledger persistence/corruption, and resumption after a commit/cleanup crash window.

## Security assessment and limitations

- This is a local filesystem primitive, not a distributed transaction or consensus protocol.
- `isSessionValid` must be wired to the real Witness authority and revocation state. The safe default rejects sessions.
- Publisher private keys and the data root must be protected by the integrating service; the helper cannot defend against a privileged attacker who can replace files and keys.
- Fsync behavior, hard links, and directory durability depend on filesystem/OS guarantees. `SIGKILL` tests process failure, not power-loss behavior.
- The replay ledger is local persistent state and must not be deleted or rolled back casually. Backups and access controls remain operator responsibilities.
- No GitHub publication or production deployment was performed.

## Result

The publisher now has a concrete API that emits staging artifacts in the exact signed format accepted by recovery, reducing the chance that production code implements an incompatible or insufficiently durable staging sequence. Production integration and environment-specific crash/power-loss validation remain outstanding.
