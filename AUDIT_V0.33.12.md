# Zion v0.33.12 — Atomic witness evidence publication audit

## Scope

This release hardens the local publication step for remote Witness evidence. The client now writes a private temporary file, fsyncs it, atomically links the complete file into the final path without replacement, fsyncs the parent directory, removes the temporary name, and syncs the directory again.

## Verification commands

```sh
npm test
npm run check
npm run demo
```

## Regression coverage added

- Successful evidence publication produces parseable complete JSON with mode `0600` and no temporary file left behind.
- An orphaned temporary file does not replace an existing evidence destination.
- Existing tests continue to verify that failed transport responses do not create evidence, prior evidence is not overwritten, and concurrent successful requests have a single destination winner.

## Safety semantics and limits

- Publication uses same-filesystem hard-link semantics. The temporary file is created in the destination directory, so it is on the same filesystem.
- If linking fails with `EEXIST`, prior evidence is preserved.
- If a directory fsync fails after the link succeeds, the operation reports failure but deliberately does not remove the linked target: durability may be uncertain, and deleting it could destroy valid evidence.
- This is an application-level crash-consistency improvement, not a guarantee against all storage hardware/controller failures. Actual power-loss durability depends on the filesystem and platform.
- TLS certificate-chain and hostname integration tests are not added in this release.
- No GitHub publication or production deployment is implied by this local package.

## Results observed for the packaged source

- `npm test`: 459 passed, 0 failed.
- `npm run check`: syntax check passed for 141 JavaScript files.
- `npm run demo`: exited successfully.
- `unzip -t`: archive integrity passed.
- `sha256sum -c`: checksum passed.
- The test suite and syntax check were repeated after extracting the final ZIP; the same results were observed.
