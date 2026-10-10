# Zion v0.33.28 — Audit: Signed Witness Temporary Recovery

## Scope

Added `src/witness-temp-recovery.js` and `test/witness-temp-recovery.test.js` on top of the locally verified v0.33.27 codebase. Package version is now 0.33.28. This is a local code artifact; no GitHub push, release publication, or deployment was performed.

## Implemented controls

- Ed25519 signature over canonicalized sidecar metadata.
- Metadata binds publisher ID, session nonce and timestamp, token ID, target relative path, SHA-256 content hash, byte length, lifecycle state, fsync assertion, and metadata ID.
- Promotion requires `READY_FOR_COMMIT`, `fsynced: true`, a configured trusted publisher public key, an unexpired session, and a caller-supplied positive session/token validator.
- Content length and SHA-256 are recomputed before promotion.
- Target path is constrained beneath the configured root; path traversal and symlink traversal in target parent components are rejected.
- `linkSync` is used for atomic no-replace commit: existing destinations are not overwritten, including a destination race.
- Missing sidecars, unpaired sidecars, corrupt metadata, invalid signatures, stale/revoked sessions, content mismatch, and destination conflicts are quarantined rather than promoted.
- Audit events are appended to JSONL and fsynced; destination and staging directories are fsynced at commit/cleanup boundaries.
- Repeated recovery after a completed commit is idempotent.

## Verification

- Focused tests: 8 passed, 0 failed.
- Full test suite: 526 passed, 0 failed.
- Syntax check: 166 JavaScript files passed.
- `npm run demo`: exit code 0.
- ZIP integrity: checked separately at release packaging time.

## Security boundaries / follow-up

- `isSessionValid` is supplied by the integrator. Production wiring must validate the live Witness session/token and durably enforce nonce single-use across restarts; the module only rejects duplicate publisher+nonce pairs within a single recovery scan.
- `fsynced: true` is a signed assertion from the staging writer, not an independent proof that the kernel/storage device honored the flush.
- Staging and destination must share a filesystem for hard-link commit. Hard-link and directory-fsync guarantees vary by OS/filesystem; this implementation is aimed at Node.js environments with those semantics.
- Recovery is a local filesystem primitive, not distributed consensus, a remote Witness service, or a substitute for authenticated authorization of the publisher key registry.
- The recovery routine does not infer that an existing destination is older/newer: it preserves any existing destination and quarantines the orphan, which is the fail-safe behavior under ambiguous ordering.
- The requested process-crash behavior is represented by constructing durable orphan artifacts and exercising the recovery loop; this version does not yet include a dedicated SIGKILL worker for the new sidecar format or a stress test with recovery racing a live publisher. Atomic no-replace protects the target against overwrite, but operational integration tests remain advisable.
