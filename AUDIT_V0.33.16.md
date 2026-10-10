# Zion v0.33.16 — Cross-process evidence publication race audit

## Scope

Added a real child-process regression for two independent Node.js processes attempting to publish valid Ed25519-signed Witness evidence to the same output path. Each process creates its own challenge and response, then uses the normal client publication path. The filesystem's exclusive hard-link commit must select exactly one winner without replacing the winner's file.

## Verification performed

Environment: Node.js v22.16.0.

- `node --test test/remote-witness-client-failures.test.js`: 14 tests passed, 0 failed.
- `npm test`: 467 tests passed, 0 failed.
- `npm run check`: syntax check passed for 142 JavaScript files.
- `npm run demo`: exit code 0; unavailable telemetry continues to yield zero budgets.
- `unzip -t`: final archive integrity passed.
- `sha256sum -c`: final archive checksum passed.

## New regression

The test launches two independent Node processes. It asserts exactly one process succeeds, the competing process fails, the committed JSON is valid, the output mode is `0600` on the test host, and per-process temporary files are cleaned up.

## Limits

- This tests a same-host local filesystem race, not a distributed/network filesystem.
- It does not simulate actual power loss, storage-controller cache loss, kernel crash, or hardware failure.
- TLS handshake tests remain local test-fixture checks and do not certify production TLS termination or deployment configuration.
- No GitHub publication or production deployment was performed.

## Reproduce

```sh
node --test test/remote-witness-client-failures.test.js
npm test
npm run check
npm run demo
```
