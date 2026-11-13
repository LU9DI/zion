# Platform keystore adapter spike

Status: **candidate identified; not approved for production and not integrated**

Scope: PR #68, branch `architecture/fully-decentralized-core`

## Objective

Select the smallest maintainable local OS credential-store boundary for wrapping Zion's random identity-record DEK. This must not introduce a hosted identity service, remote escrow, plaintext fallback, or a mandatory central dependency.

## Candidate evaluated

The first candidate for a Windows/Linux implementation spike is `@napi-rs/keyring` (reviewed version: **2.1.2**).

Its upstream API exposes `Entry` with `getPassword()`, `setPassword()`, and `deletePassword()`. The upstream README documents the Windows credential store and Linux Secret Service backend. Linux selection is security-sensitive: the default may silently fall back to kernel keyutils, which is in-memory and does not survive reboot. The adapter must therefore explicitly request `{ linux: { store: 'secret-service' } }` and treat an unavailable Secret Service as a hard startup failure. It must never accept keyutils as an identity-wrapping backend.

References:
- https://github.com/Brooooooklyn/keyring-node
- https://www.npmjs.com/package/@napi-rs/keyring

## Proposed narrow mapping

- Windows: Windows Credential Manager, scoped to the current OS user.
- Linux: Secret Service only (for example, GNOME Keyring, KWallet, or KeePassXC Secret Service); no keyutils fallback.
- macOS: out of scope for this first spike until Keychain behavior and CI coverage are independently verified.
- Other operating systems: unsupported; official mode fails closed.

The Zion adapter would store a randomly generated 256-bit wrapping key as base64 in the OS credential store. The existing identity-record core would continue to perform AES-256-GCM DEK wrapping and would never receive the OS wrapping key itself. The stored wrapping key must be non-exportable through the application-facing adapter contract; the underlying OS API may return it to the process only for the narrow wrap/unwrap operation.

## Blocking questions before adoption

1. Confirm exact package version, platform package selection, integrity hashes, license notices, and native Rust third-party license inventory in the repository's dependency/SBOM workflow.
2. Verify Windows Credential Manager behavior on supported Windows versions and Linux Secret Service behavior in headless service deployments, including locked/unavailable keyrings and user-session lifecycle.
3. Prove concurrent first-start behavior across independent processes. The exposed get/set API is not documented as an atomic create-if-absent operation; a race must not replace a wrapping key after an identity record has been written.
4. Define a cross-process provisioning lock and crash recovery without introducing an unsafe lock-file path or stale-lock takeover race.
5. Verify deletion, account scoping, permission boundaries, and behavior after OS account migration, credential-store reset, and machine replacement.
6. Add real OS-backed integration tests in supported CI runners. Fake keystores remain unit-test-only.
7. Complete dependency and supply-chain review, including native binary provenance and transitive Rust license inventory.

## Explicit non-decisions

- No dependency has been added and no production adapter has been implemented.
- No automatic backend fallback is permitted.
- No plaintext file, environment-variable, generated-on-every-start, or remote fallback is permitted.
- No claim is made that Credential Manager or Secret Service alone protects an endpoint after compromise of the logged-in user or running process.
- Filesystem persistence, atomic publication, ACL/reparse-point checks, restart continuity, backup/recovery, and rotation remain separate required gates.
- The official launcher must not accept this candidate until the real adapter and all required gates pass.

## Next implementation gate

Build a disposable cross-process spike outside the official launcher. It must demonstrate stable wrap/unwrap across process restarts, reject a missing/locked backend, and prove that two simultaneous first-start processes cannot replace or orphan the wrapping key. Only after that evidence should the package be pinned in the project manifest and integrated behind the existing local-keystore interface.
