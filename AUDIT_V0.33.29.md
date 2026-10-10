# Zion v0.33.29 — Witness crash and concurrency verification

## Scope

Continues v0.33.28. This release adds real child-process tests for crash recovery and simultaneous recovery attempts. It is a local artifact only; no GitHub push, release publication, or deployment was performed.

## Changes

- Added a child process that writes and fsyncs a temporary payload and Ed25519-signed `.meta` sidecar, signals that staging is complete, and is terminated with `SIGKILL`. A fresh recovery invocation then validates and commits the orphan.
- Added a two-process race test that invokes recovery concurrently against the same signed temporary. The test verifies exactly one recovery reports success and the final destination retains the expected bytes.
- Package version advanced to `0.33.29`.

## Verification performed

- Focused Witness temporary recovery tests: 10 passed, 0 failed, including the two new process-level tests.
- Full test suite: 528 passed, 0 failed.
- Syntax check: 166 JavaScript files passed.
- `npm run demo`: exit code 0.
- `npm run client:demo`: exit code 0; demo reports 7 chunks, 52 plaintext bytes, and ciphertext-only adapter storage.
- ZIP archive integrity checked with `unzip -t`.

## Security boundaries

- SIGKILL test validates process-crash recovery after staging files are fsynced; it is not a power-loss/hardware durability test. The worker does not claim to prove that storage hardware honored persistence.
- The no-replace hard-link commit protects the target from overwrite during a destination race. The simultaneous test does not establish a global lock for the whole recovery scan, nor does it guarantee a single audit event in every possible scheduling interleaving.
- Cross-restart replay protection remains dependent on an integrator-provided durable, atomic nonce/session ledger. The built-in duplicate nonce check is scoped to a single scan.
- Session validation is still an integration callback. Production must connect it to the live Witness token/session authority and enforce nonce single-use durably.
- This release has not been deployed or connected to a production Witness instance.
