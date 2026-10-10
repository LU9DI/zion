# Zion v0.33.19 — Bounded Witness artifact inspection audit

## Scope

Built on v0.33.18. The read-only temporary-artifact diagnostic now caps content inspection at 1 MiB per candidate file. Files already known to exceed the cap are reported as `oversized-uninspected` without reading or hashing content. After a bounded read, the diagnostic compares device, inode, size, mtime, and ctime metadata before and after inspection; a detected change produces `changed-during-inspection` and no content classification or hash. No recovery or cleanup is performed.

## Verification performed

- `node --test test/diagnose-witness-evidence.test.js`: 6 passed, 0 failed.
- `npm test`: 476 passed, 0 failed.
- `npm run check`: syntax check passed for 145 JavaScript files.
- `npm run demo`: exit code 0; unavailable telemetry continued to produce zero budgets.
- ZIP integrity and SHA-256 checked after packaging.

## New regression

A sparse temporary artifact larger than 1 MiB is reported as oversized; the diagnostic reads zero bytes, does not emit a hash, and leaves the file unchanged.

## Safety boundary and limitations

This remains a read-only local diagnostic. The size cap and metadata comparison reduce memory-exhaustion risk and identify many concurrent modifications, but do not create an atomic filesystem snapshot or eliminate every possible race on all filesystems. A stable hash and valid JSON do not establish signature validity, signer identity, freshness, or trust. No automatic promotion/deletion, GitHub publication, or production deployment was performed. Tests do not simulate power loss, kernel crashes, storage-controller cache loss, or certify network/distributed filesystem behavior.

## Reproduce

```sh
node --test test/diagnose-witness-evidence.test.js
npm test
npm run check
npm run demo
npm run anchor:diagnose-witness-evidence -- /path/to/evidence.json
```
