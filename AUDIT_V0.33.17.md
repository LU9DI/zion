# Zion v0.33.17 — Witness crash-boundary publication audit

## Scope

This release adds deterministic subprocess fault injection around the client's atomic hard-link publication boundary. The injected failures are isolated to child processes launched by the regression tests; normal production execution has no environment-driven crash hooks.

## Verification performed

Environment: Node.js v22.16.0.

- `node --test test/remote-witness-crash-boundaries.test.js`: 3 passed, 0 failed.
- `npm test`: 470 passed, 0 failed.
- `npm run check`: syntax check passed for 143 JavaScript files.
- `npm run demo`: exit code 0; missing telemetry continues to yield zero budgets.
- Final ZIP archive integrity and SHA-256 were checked after packaging.

## New regressions

1. **Crash before link:** hard-killing the client before the atomic link leaves no destination file. A uniquely named temporary file can remain, but its bytes are complete JSON because the file was written and fsynced before the commit point.
2. **Crash after link:** hard-killing the client immediately after the link leaves a complete destination with restrictive permissions. A temporary hard-link alias may remain because cleanup did not execute.
3. **Directory fsync failure:** the client exits with an error, but the already-visible destination is preserved. The implementation does not attempt to roll back evidence after the commit point; the caller must treat durability as uncertain.

## Limits

- These tests simulate process termination, not power loss, kernel crash, storage-controller cache loss, or physical media failure.
- Directory `fsync` semantics vary by operating system and filesystem. The tests run on the local filesystem in the test environment.
- A crash before cleanup can leave an orphan temporary name. Automated deletion is intentionally not performed because ownership and recovery state cannot be inferred safely from the name alone.
- No GitHub publication or production deployment was performed.

## Reproduce

```sh
node --test test/remote-witness-crash-boundaries.test.js
npm test
npm run check
npm run demo
```
