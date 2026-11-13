# Node identity lifecycle ADR

Status: **encrypted identity-record core implemented; filesystem persistence and platform-keystore adapters pending**  
Scope: PR #68, branch `architecture/fully-decentralized-core`

## Context and verified current behavior

The current Zion identity is an Ed25519 keypair. `src/peer-security.js` exports the public key as SPKI PEM and derives `nodeId` as the SHA-256 digest of the SPKI DER public key. `createNodeIdentity()` generates a new keypair in memory; it does not persist it.

The official launcher requires a deployment-owned adapter to inject `identity`, but does not define that adapter's storage, backup, restore, rotation, or restart contract. Therefore identity continuity in an actual deployment remains unverified.

Project governance stores public keys and node IDs in project-scoped governance state. A node identity is not a project encryption key, a storage-content key, or a governance threshold by itself. These key purposes must remain separate.

## Decision

The official node identity will be a long-lived, locally owned Ed25519 key, persisted through a **local platform-keystore adapter**. The platform keystore is a device-local security boundary (for example, an OS credential vault, TPM, or HSM); it is not a hosted identity provider and must not be required to contact any central service.

The private key will not be stored in plaintext. The local identity record will be encrypted with AES-256-GCM under a random 256-bit data-encryption key (DEK). The DEK is wrapped/unwrapped by the local platform-keystore adapter and is never stored beside the identity file in plaintext. No hard-coded key, default password, plaintext environment-variable fallback, or remote key escrow is permitted in official mode.

If a platform has no usable local keystore, official mode must fail closed with a clear provisioning error. It must not silently fall back to plaintext files or regenerate a new identity on every restart.

## Identity record and cryptographic invariants

A versioned record should contain only the minimum needed to recover and verify identity:

- schema/version and algorithm identifiers;
- the existing Zion `nodeId`;
- public key in canonical SPKI DER (or a documented canonical representation);
- AEAD nonce, ciphertext, and authentication tag;
- wrapped DEK and platform-keystore key reference/version;
- creation metadata needed for diagnostics, without secrets.

The encrypted plaintext contains the PKCS#8 Ed25519 private key. On load, the implementation must:

1. Validate exact schema, supported version, bounded field sizes, and encoding before expensive operations.
2. Unwrap the DEK only through the local keystore adapter and require exactly 32 bytes.
3. Authenticate/decrypt with AES-256-GCM using a domain-separated AAD binding the schema, algorithm, and expected node ID.
4. Import the PKCS#8 private key using Node's supported crypto APIs; derive its public key.
5. Compare derived SPKI DER byte-for-byte with the stored public key and recompute SHA-256(SPKI DER); reject any mismatch.
6. Return a KeyObject-backed identity compatible with existing signing code. Never log, serialize into diagnostics, or expose private key bytes.
7. Zero temporary DEK buffers on every success and failure path where the runtime permits.

The existing Zion node ID derivation is retained for continuity. A libp2p PeerId is a separate identifier until proven otherwise. Only supported js-libp2p key import/export APIs may be used. A stable PeerId mapping must be demonstrated by tests; no custom protobuf, multihash, or PeerId conversion code is allowed.

## Filesystem and crash-safety requirements

- Identity directory must be a real directory, not a symlink or reparse-point escape; use restrictive owner-only permissions/ACLs.
- Identity file must be a regular file, opened without following symlinks where supported.
- Create a new record in a same-directory exclusive temporary file, write all bytes, fsync the file, atomically publish without overwriting an existing identity, then fsync the containing directory where supported.
- Concurrent first-start attempts must converge on the one already-published identity. They must never replace it with a second generated identity.
- Rotation must use a separate versioned transaction and recover deterministically after interruption. Do not delete the prior valid record until the new record and committed governance transition are recoverable.
- On platforms where POSIX mode bits do not enforce ACLs, the adapter must verify platform-specific owner-only ACLs. A best-effort chmod is not sufficient evidence.
- Corrupt, truncated, unauthenticated, unknown-version, or mismatched records must fail closed. No automatic key regeneration or silent recovery.
- Backups must be explicit, encrypted, authenticated, versioned, and tested on a clean machine. A backup must not depend on the original machine's non-exportable wrapping key; use a separate user-controlled recovery secret or recovery device. Recovery secrets must not be stored beside the backup.

## Rotation, revocation, and recovery

A key rotation creates a new identity and therefore normally a new Zion node ID. It is not a silent in-place overwrite.

For project-governor rotation:
- The proposal binds the project ID, next epoch, previous committed state hash, old node ID, and new node ID/public key.
- The old identity signs the transition and the new identity signs proof of possession of the new private key. Adding a governor also requires the proposed new identity to prove possession; threshold approval alone cannot enroll an unproven key.
- The project's existing governance threshold approves the exact proposal hash.
- The transition becomes authoritative only after the distributed consensus layer commits it. The current governance state-machine helper alone does not establish canonical commitment.
- Nodes reject old-key authority after observing the committed revocation/rotation epoch, while retaining audit evidence.

For a lost or compromised key, recovery must follow the project's previously committed recovery policy. A single operator, hosted service, or support team must not be able to silently replace a project governor. If the configured threshold is unavailable, the system must fail safely and require the explicitly defined recovery path; it must not invent a central override.

## Local keystore adapter contract

The adapter is local and replaceable, with a narrow interface equivalent to:

- `createOrGetWrappingKey({ keyId, purpose })` — creates or retrieves a non-exportable local wrapping key;
- `wrapKey({ keyId, plaintextKey })` — wraps a fresh DEK;
- `unwrapKey({ keyId, wrappedKey })` — returns the DEK only to the local process;
- `deleteKey({ keyId })` — used only after a verified rotation/recovery lifecycle.

The production adapter must document its OS/TPM/HSM boundary, access controls, backup limitations, and behavior when the device keystore is unavailable. Tests may use a deterministic fake adapter, but test keys must never be accepted in official production mode.

## Required tests before official adoption

1. Generate once; close the process; reopen in a separate process; prove the same node ID and signing key.
2. Two concurrent first-start processes publish exactly one identity; neither silently replaces the other's result.
3. Wrong wrapping key, modified ciphertext/tag/AAD, malformed record, symlink, directory substitution, truncated file, and unsupported schema all fail closed.
4. File and directory permissions/ACLs are verified on each supported OS, not inferred from chmod calls.
5. Backup restores on a clean machine using only the documented recovery material; wrong recovery material fails.
6. Rotation interruption at every durable-write boundary recovers to either the old valid identity or the committed new identity, never a half-state.
7. Old and new keys both sign the exact rotation transition; invalid proof of possession, stale epoch, wrong previous hash, and insufficient threshold are rejected.
8. The same Ed25519 key produces the same supported libp2p PeerId before and after restart; wrong-key substitution is rejected.
9. CI exercises at least two independent Node.js processes; in-process mocks alone are insufficient.
10. Threat-model review covers malware with local user privileges, disk theft, backup theft, OS compromise, TPM reset, and device replacement. Hardware-backed storage does not protect a key from a fully compromised running endpoint.

## Implementation status and sequencing

The PR now contains `src/node-identity-record.js`, a cryptographic core that creates and restores a versioned AES-256-GCM identity record through an injected local-keystore interface. It verifies the Ed25519 private/public key match and recomputed Zion node ID on restore, binds record metadata as AEAD associated data, enforces exact record fields and bounded encodings, and clears temporary DEK/private-key DER buffers where Node permits. Tests use a local fake keystore only; this is not a production OS adapter and is not accepted by the official launcher.

1. Add and validate at least one real OS-backed adapter (Windows credential/DPAPI boundary or Linux Secret Service/TPM/HSM) with platform-specific access-control checks.
2. Implement crash-safe, exclusive filesystem persistence, process coordination, atomic publication, fsync, symlink/reparse-point protection, and recovery semantics.
3. Add separate-process restart and concurrent first-start tests using the real adapter on supported CI platforms.
4. Integrate the identity store with the official launcher only after those gates pass, without changing admission/transport behavior in the same change.
5. Prove backup/recovery and interrupted rotation behavior before testing libp2p key import.
6. Add the libp2p PeerId compatibility spike only after stable identity persistence passes.
7. Keep PostgreSQL admission, static trusted-peer bootstrap, and existing transport clearly marked transitional until their decentralized replacements independently pass their own gates.

## Explicit limitations

This ADR does not claim that an OS keystore, TPM, or HSM makes a compromised endpoint safe. It does not implement distributed BFT, project consensus, DHT discovery, or key revocation propagation. It does not authorize a merge, deployment, release, or database migration. No production private key or deployment secret was accessed.
