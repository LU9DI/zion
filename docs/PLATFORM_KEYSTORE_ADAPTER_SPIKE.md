# Platform keystore adapter spike

Status: **candidate only; blocked on safe provisioning semantics; not approved for production or integrated**

Scope: PR #68, branch `architecture/fully-decentralized-core`

## Objective

Select the smallest maintainable local OS credential-store boundary for wrapping Zion's random identity-record DEK. This must not introduce a hosted identity service, remote escrow, plaintext fallback, or a mandatory central dependency.

## Candidate evaluated

The first candidate for a Windows/Linux implementation spike is `@napi-rs/keyring@2.1.2`.

Its API exposes `Entry.getPassword()`, `setPassword()`, and `deletePassword()`. The upstream README documents Windows credential storage and Linux Secret Service. Linux selection is security-sensitive: the default may silently fall back to kernel keyutils, which is in-memory and does not survive reboot. The adapter must explicitly request `{ linux: { store: 'secret-service' } }` and fail closed if unavailable. It must never accept keyutils as an identity-wrapping backend.

The package's documented get/set API does **not** establish an atomic create-if-absent or compare-and-swap primitive. A naive read-then-write implementation is racy: two first-start processes can both observe a missing credential and then overwrite each other's wrapping key. One process could publish an identity record encrypted under a key that the other process subsequently replaces. Therefore this package is not yet suitable as a direct implementation of the existing `createOrGetWrappingKey` contract.

References:
- https://github.com/Brooooooklyn/keyring-node
- https://www.npmjs.com/package/@napi-rs/keyring

## Proposed narrow mapping

- Windows: Windows Credential Manager, scoped to the current OS user.
- Linux: Secret Service only (for example, GNOME Keyring, KWallet, or KeePassXC Secret Service); no keyutils fallback.
- macOS: out of scope for this first spike until Keychain behavior and CI coverage are independently verified.
- Other operating systems: unsupported; official mode fails closed.

The adapter would store a randomly generated 256-bit wrapping key as base64 in the OS credential store. The identity-record core continues to perform AES-256-GCM DEK wrapping; it must never receive the OS wrapping key except as a transient value inside the adapter's wrap/unwrap operation.

## Required provisioning protocol

The adapter must satisfy the existing `createOrGetWrappingKey` contract across **independent processes**, not merely concurrent promises in one process.

A viable candidate protocol is a per-identity, cross-process exclusive provisioning gate in a protected, user-owned state directory:

1. Validate the state directory and every path component against symlink/reparse-point substitution and unsafe ownership/ACLs before touching lock state.
2. Acquire a kernel-enforced exclusive primitive (not an in-process mutex and not a check-then-create sequence).
3. Re-read the OS credential while holding the gate. If present, validate its exact format and return without changing it.
4. If absent, generate the wrapping key once, store it, read it back, and compare it in constant time before releasing the gate.
5. Never overwrite a credential that appeared unexpectedly. Treat ambiguous store outcomes as fatal and require recovery rather than guessing.
6. Release the gate only after the credential has been read back and verified.

Automatic stale-lock deletion is prohibited unless the implementation can prove ownership and process death without PID-reuse or TOCTOU races. The initial spike may prefer fail-closed availability: an abandoned gate requires explicit operator recovery after confirming no initializer is active. It must not silently steal a lock.

This protocol itself still needs a platform-specific implementation and adversarial tests. A lock directory created with ordinary path APIs is not accepted until path/ACL/reparse-point protections and crash behavior are proven.

## Blocking validation gates

1. Confirm exact package version, platform package selection, integrity hashes, license notices, and native Rust third-party license inventory in the repository's dependency/SBOM workflow.
2. Verify Windows Credential Manager behavior and Linux Secret Service behavior in interactive and headless service deployments, including locked/unavailable stores and user-session lifecycle.
3. Prove two or more independent processes racing on first initialization cannot replace, orphan, or disagree about the wrapping key.
4. Prove restart continuity, crash recovery, and fail-closed behavior after interruption at every provisioning step.
5. Verify deletion, account scoping, permission boundaries, OS account migration, credential-store reset, and machine replacement.
6. Add real OS-backed integration tests on supported CI runners. Fake keystores remain unit-test-only.
7. Complete dependency and supply-chain review, including native binary provenance and transitive Rust license inventory.

## Explicit non-decisions

- No dependency has been added and no production adapter has been implemented.
- No automatic backend fallback is permitted.
- No plaintext file, environment-variable, generated-on-every-start, or remote fallback is permitted.
- No claim is made that Credential Manager or Secret Service alone protects an endpoint after compromise of the logged-in user or running process.
- Filesystem persistence, atomic publication, ACL/reparse-point checks, backup/recovery, and rotation remain separate required gates.
- The official launcher must not accept this candidate until the real adapter and all required gates pass.

## Next implementation gate

Build a disposable cross-process spike outside the official launcher. First prove the exclusive provisioning primitive and its crash semantics independently of the keyring library; then test the real OS store through process restarts and concurrent initialization. Only after that evidence should the package be pinned in the project manifest and integrated behind the local-keystore interface.

## Repository audit: existing event-journal lock is not an identity gate

The current `src/signed-project-event-log.js` implementation was inspected at the PR #68 audit head. It creates a sibling lock file with Node.js `openSync(path, 'wx', 0o600)`, writes a PID/random token, and keeps the file descriptor open while the journal instance is active. On close it closes the descriptor, reads the pathname, and removes the file only if the stored PID/token match.

This is useful single-writer coordination for the current journal implementation, but it is **not approved as the node-identity provisioning or rotation gate**:

- The journal constructor creates the parent directory recursively; this code does not validate every path component, ownership, Windows ACLs, or reparse-point state before using the lock path.
- The lock protocol is pathname-based. The code does not establish a platform-reviewed, handle-lifetime locking contract covering directory replacement, hostile path substitution, or the close/read/unlink sequence.
- It does not provide a tested transaction spanning OS-keystore no-overwrite creation, credential read-back, encrypted-record publication, directory durability, and crash recovery.
- The journal lock tests therefore cannot be counted as evidence for independent-process identity provisioning safety.

Do not reuse this lock as a security boundary or extend it with stale-lock stealing. Keep identity provisioning blocked until a disposable Windows/Linux spike demonstrates the required kernel-enforced exclusion and adversarial path/crash tests on each supported platform. This audit makes no claim that the journal's existing lock is exploitable in every deployment; it records that its current guarantees are insufficient for the stronger identity-lifecycle contract.
