# Zion v0.33.9 — Witness fail-closed recovery audit

## Scope

This release adds process-level regression tests for two recovery-critical failure modes in the remote Witness service: corrupt committed state and an abandoned state lock. The intended behavior is fail-closed; the service must not silently replace corrupt state or steal a lock whose ownership cannot be established.

## Reproduction

Requirements: Node.js 20 or later.

```sh
npm test
npm run check
npm run demo
sha256sum -c zion-v0.33.9-witness-fail-closed-recovery.zip.sha256
unzip -t zion-v0.33.9-witness-fail-closed-recovery.zip
```

## Observed local results

- `npm test`: **449 passed, 0 failed**.
- `npm run check`: passed; **140 JavaScript files** syntax-checked.
- `npm run demo`: exited with code 0; critical host conditions and unavailable telemetry produce zero budgets.
- The new corruption regression confirms HTTP 503, `witness_state_unavailable`, and byte-for-byte preservation of the corrupt state file.
- The new abandoned-lock regression confirms HTTP 503, preservation of the lock directory and owner evidence, and no state publication.
- ZIP integrity and SHA-256 are verified after archive creation.

## Security interpretation

These tests show the observed local service behavior under the two injected conditions. They do not prove resistance to arbitrary filesystem races, malicious storage administrators, power loss, rollback of snapshots, cross-host distributed locking, public TLS deployment, or production traffic. Abandoned locks require operator-led investigation; do not delete them solely because they appear old.

## Release evidence

Record Node.js version, operating system and filesystem, exact commands, exit codes, test count, syntax-check count, demo result, ZIP integrity, and SHA-256 when reproducing this release in another environment.

No GitHub publication or production deployment is claimed.
