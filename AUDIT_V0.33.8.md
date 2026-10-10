# Zion v0.33.8 — Operational recovery audit

## Scope

This report records repeatable local checks for the file-backed checkpoint anchor and Witness-related code. It is not a certification of production security.

## Reproduction

Run from the extracted package root with Node.js 20 or later:

```sh
npm test
npm run check
npm run demo
```

To verify the distributed source archive after packaging:

```sh
sha256sum zion-v0.33.8-operational-recovery-audit.zip
unzip -t zion-v0.33.8-operational-recovery-audit.zip
```

## Recovery invariants exercised

- Corrupt committed checkpoint JSON is reported as corruption; it is not replaced automatically.
- An existing or abandoned lock is not automatically stolen. A timeout fails closed and leaves the lock available for operator investigation.
- A lock replaced by another owner is not unlinked by the original publisher.
- The lock is created exclusively with owner-only `0600` permissions on POSIX-like filesystems. Filesystem permission semantics vary by platform and process umask.
- Checkpoint files are atomically replaced, use `0600` permissions on supported filesystems, and file plus parent-directory sync failures are surfaced as durability uncertainty.
- Orphan temporary files are not treated as committed state and are preserved for forensic inspection.

## Results observed in this build environment

- `npm test`: **447 passed, 0 failed**.
- `npm run check`: passed; **139 JavaScript files** syntax-checked.
- `npm run demo`: exited with code 0; the busy-host and missing-telemetry cases produced zero budgets.
- ZIP archive integrity and SHA-256 are checked after archive creation; the checksum file is distributed beside the ZIP.

These results are local reproducibility evidence for this extracted source tree, not an independent third-party audit.

## Limits and operational handling

1. Never delete a stale-looking lock solely because its PID or timestamp looks old. Confirm process ownership and storage semantics independently, preserve the lock/evidence, then document any manual recovery.
2. A successful local `fsync` test is not a power-loss certification and does not override filesystem, mount, virtualization, or hardware behavior.
3. TLS correctness depends on actual certificate provisioning, hostname verification, trust roots, rotation, and deployment configuration. Local tests do not establish those facts for a public endpoint.
4. Local multi-process tests do not prove distributed locking across hosts or network filesystems.
5. No public deployment or GitHub publication is claimed by this package.

## Evidence fields to record for a release

- Node.js version and operating system/filesystem
- Exact commands and exit codes
- Test count and failures
- Syntax-check file count
- Demo exit code and telemetry availability behavior
- ZIP integrity result and SHA-256
- Explicitly untested external conditions
