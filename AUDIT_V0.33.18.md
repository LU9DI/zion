# Zion v0.33.18 — Read-only Witness temporary-artifact diagnostics audit

## Scope

Added `scripts/diagnose-witness-evidence.js` and the `anchor:diagnose-witness-evidence` npm script. The diagnostic inventories only UUID-named temporary artifacts produced by the remote Witness evidence publisher. It classifies JSON syntax, detects hard-link aliases by device/inode identity, reports byte count, file mode and SHA-256, and avoids following symlinks. It does not mutate files.

## Verification performed

Environment: Node.js runtime in the current workspace.

- `node --test test/diagnose-witness-evidence.test.js`: 5 passed, 0 failed.
- `npm test`: 475 passed, 0 failed.
- `npm run check`: syntax check passed for 145 JavaScript files.
- `npm run demo`: exit code 0; idle, host-busy and unavailable-telemetry scenarios produced expected budget outputs.
- Archive integrity and SHA-256 checked after packaging.

## New regressions

1. JSON-syntax-valid orphan is identified but explicitly not treated as trusted evidence.
2. Malformed JSON is classified without changing bytes.
3. Post-publication hard-link alias is detected by inode identity.
4. Unrelated manually named files are ignored, and symlinks are not followed.
5. Existing destination remains byte-for-byte unchanged; no-artifact report is valid.

## Safety boundary

This release adds **diagnosis, not automatic recovery**. The command does not delete, rename, promote, or overwrite anything. A parseable JSON document may still have an invalid signature, wrong identity, stale nonce, or untrusted key; those checks are not performed by this inventory command. Operators must preserve evidence and use the established Witness verification flow before any manual recovery decision.

The tests are local filesystem regressions. They do not simulate power loss, kernel crashes, storage-controller cache loss, physical media failure, or establish semantics on network/distributed filesystems. No GitHub publication or production deployment was performed.

## Reproduce

```sh
node --test test/diagnose-witness-evidence.test.js
npm test
npm run check
npm run demo
npm run anchor:diagnose-witness-evidence -- /path/to/evidence.json
```
