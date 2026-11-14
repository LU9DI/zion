# Node identity lifecycle ADR

Status: **encrypted identity-record core implemented; filesystem persistence and platform-keystore adapters pending**  
Scope: PR #68, branch `architecture/fully-decentralized-core`

## Current implementation

`src/node-identity-record.js` implements the cryptographic core for a versioned AES-256-GCM identity record. It wraps a random DEK through an injected local-keystore interface, verifies Ed25519 keypair/node-ID consistency on restore, validates bounded record schemas, and clears temporary key buffers where possible. Current tests use a fake keystore only. This is not a production OS adapter and is not integrated into the official launcher.

## Verified runtime limitations

The current identity is an Ed25519 keypair. `src/peer-security.js` exports the public key as SPKI PEM and derives `nodeId` as SHA-256(SPKI DER). `createNodeIdentity()` generates a new keypair in memory; it does not persist it.

The official launcher requires a deployment-owned adapter to inject `identity`, but the repository does not define that adapter's storage, backup, restore, rotation, or restart contract. Identity continuity in an actual deployment therefore remains unverified. The launcher also still requires PostgreSQL and a static trusted-peer list; neither is the final decentralized design.

## Decision

The official node identity must be a long-lived, locally owned Ed25519 key, persisted through a local platform-keystore adapter. The keystore is a device-local security boundary (OS credential vault, TPM, or HSM), not a hosted identity provider. It must not require contacting a central service.

The private key must not be stored in plaintext. The local identity record is encrypted with AES-256-GCM under a random 256-bit DEK, wrapped/unwrapped only by the local keystore. No hard-coded key, default password, plaintext environment-variable fallback, or remote key escrow is permitted in official mode. If no usable local keystore exists, official mode fails closed; it must not regenerate an identity on restart.

## Local keystore contract

The adapter exposes a narrow interface equivalent to:

- `createOrGetWrappingKey({ keyId, purpose })` — atomically creates or retrieves an immutable local wrapping key across independent processes;
- `wrapKey({ keyId, plaintextKey })` — wraps a fresh DEK;
- `unwrapKey({ keyId, wrappedKey })` — returns the DEK only to the local process;
- `deleteKey({ keyId })` — only after a verified rotation/recovery lifecycle.

The create-or-get operation must be atomic across processes. A read-then-write implementation is unsafe: concurrent initializers can overwrite each other's wrapping key and orphan an already-published identity record.

The first candidate, `@napi-rs/keyring@2.1.2`, exposes get/set/delete but does not document an atomic create-if-absent operation. It is therefore **not approved for direct production integration**. Linux must explicitly pin Secret Service and fail closed; the default backend may silently fall back to kernel keyutils, which does not persist across reboot. See `docs/PLATFORM_KEYSTORE_ADAPTER_SPIKE.md`.

## Keystore byte ownership and memory limits

The adapter boundary has explicit mutable-byte ownership requirements:

- `wrapKey` receives an isolated borrowed copy of the DEK, not the buffer used by AES-GCM. It must finish using the bytes before its promise resolves and must not retain the buffer or any alias. The caller wipes both its working DEK and the adapter input copy in `finally`; this prevents adapter mutation from changing the encryption key and clears retained aliases after settlement.
- `unwrapKey` must return a mutable `Uint8Array` containing the plaintext DEK. Ownership of that returned view transfers to the caller; the adapter must not retain the view or aliases. The caller copies it for cryptographic use and wipes both the adapter-returned view and its local copy in `finally`, including authentication/decryption failure paths.
- Adapters must not return immutable values, detached views, or shared mutable backing storage. A future production adapter must test and document this contract for its concrete native binding.
- Cleanup uses the captured TypedArray intrinsic rather than a potentially overridden instance `.fill()` method. Detached or proxy-backed views may still be impossible to wipe; cleanup is best-effort and must not mask the primary cryptographic error. The module cannot prove that a native adapter has no hidden copies. Fake-keystore tests establish only JavaScript-visible buffer behavior.

Zeroization is best-effort within the limits of Node.js and native cryptographic APIs. Clearing the temporary DER buffer does not erase the returned private `KeyObject`, native-library internal copies, garbage-collected copies, swap, crash dumps, or memory snapshots. The restored `KeyObject` necessarily remains live while the node needs to sign. Do not describe this as complete process-memory erasure or endpoint-compromise protection.
## Bootstrap and crash recovery

The mandatory state machine and transaction protocol are specified in `docs/NODE_IDENTITY_BOOTSTRAP_PROTOCOL.md`. Key invariants:

- A published identity is never silently replaced or regenerated.
- Provisioning and rotation require a kernel-enforced cross-process exclusive gate.
- A wrapping key is immutable for its key ID; unexpected pre-existing credentials are never overwritten.
- Record publication must be exclusive, same-directory, crash-safe, and durably synchronized.
- Ambiguous or interrupted state enters `RECOVERY_REQUIRED`; startup fails closed.
- Automatic stale-lock stealing is prohibited until process death, PID reuse, and TOCTOU behavior are proven on each supported OS.
- Machine migration requires explicit user-controlled or governance-authorized recovery material; no central escrow.

## Filesystem and platform requirements

- Validate the state directory and path components against symlink/reparse-point substitution and unsafe ownership/ACLs.
- Use restrictive owner-only permissions/ACLs; best-effort chmod is not sufficient on Windows.
- Use exclusive temporary-file creation, file fsync, atomic no-overwrite publication, and directory fsync where supported.
- Reject malformed, truncated, unauthenticated, unknown-version, or mismatched records.
- Verify behavior after OS account migration, credential-store reset, machine replacement, and interrupted rotation.

## Rotation and governance

Rotation creates a new identity and normally a new node ID; it is not a silent in-place overwrite. Project-governor rotation requires the outgoing identity's signature, proof of possession by the new identity, threshold approval of the exact proposal hash, and eventual commitment by a distributed consensus layer. The current governance helper is a state-machine primitive, not BFT consensus.

## Required evidence before launcher integration

1. Real OS-backed keystore integration on supported Windows and Linux CI.
2. Separate-process restart continuity and simultaneous first-start tests.
3. Crash injection at every provisioning and publication boundary.
4. Wrong-key, tamper, symlink/reparse-point, ACL, and path-substitution rejection.
5. Explicit backup/machine migration recovery on a clean machine.
6. Interrupted key rotation recovery without identity loss or silent replacement.
7. libp2p PeerId compatibility only after stable identity persistence is proven.

## Non-goals and safety

This ADR does not certify endpoint security, implement BFT, DHT discovery, or distributed revocation propagation. It does not authorize merge, deployment, release, or database migrations. Fake keystores remain test-only and must never be accepted in official production mode.
