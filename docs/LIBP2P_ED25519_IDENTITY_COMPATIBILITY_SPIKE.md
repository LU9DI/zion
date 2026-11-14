# libp2p Ed25519 identity compatibility spike

Status: **API path identified; no dependency added and no compatibility test executed**

Scope: PR #68, branch `architecture/fully-decentralized-core`

## Goal

Prove that Zion's existing Ed25519 identity can be imported into the maintained js-libp2p key API without changing the existing Zion node ID, private key, public key, or signing behavior. A libp2p PeerId remains a separate identifier until the proof is complete.

## Current source identity

`src/node-identity-record.js` restores a Node.js Ed25519 `KeyObject` and validates its SPKI DER public key and SHA-256-derived Zion node ID. It currently stores the private key as PKCS#8 DER inside the authenticated encrypted record. The production keystore and filesystem persistence gates remain open.

## Candidate supported API

The current published `@libp2p/crypto` API documentation exposes:

- `privateKeyFromRaw(Uint8Array)`, which imports Ed25519 private material in the documented 64-byte form;
- `publicKeyFromRaw(Uint8Array)`;
- `privateKeyToProtobuf(PrivateKey)` and `privateKeyFromProtobuf(Uint8Array)`;
- Ed25519 private-key objects with a corresponding public key and signing method.

The documented Ed25519 raw private-key representation is 64 bytes: private seed bytes followed by public-key bytes. Node.js can expose the Ed25519 private/public JWK members as `d` and `x`; a future spike may decode those canonical base64url values and pass their concatenation to `privateKeyFromRaw`. It must not parse PKCS#8 with handwritten ASN.1 offsets or invent a custom libp2p protobuf/multihash encoder.

References checked:
- https://libp2p.github.io/js-libp2p/functions/_libp2p_crypto.keys.privateKeyFromRaw.html
- https://libp2p.github.io/js-libp2p/modules/_libp2p_crypto.keys.html
- https://libp2p.github.io/js-libp2p/interfaces/_libp2p_interface.Ed25519PrivateKey.html
- https://github.com/libp2p/specs/blob/master/peer-ids/peer-ids.md
- `@libp2p/crypto@5.0.6` published source: https://app.unpkg.com/@libp2p/crypto@5.0.6/files/src/keys/index.ts

These references identify candidate APIs and formats; they do not establish Zion compatibility or production suitability.

## Required isolated proof

1. Pin an exact mutually compatible js-libp2p package set only in a disposable spike; do not change the Zion manifest yet.
2. Generate one Zion Ed25519 identity and import it using only supported `@libp2p/crypto` APIs.
3. Assert byte-for-byte equality of the 32-byte public key and verify signatures in both directions: Node.js signs/libp2p verifies and libp2p signs/Node.js verifies.
4. Derive the libp2p PeerId using supported PeerId APIs and assert it remains identical after export/import and a separate-process restart.
5. Assert wrong seed, wrong appended public key, malformed lengths, and a different identity are rejected.
6. Verify that the existing Zion node ID remains exactly SHA-256(SPKI DER); do not silently redefine it as a PeerId.
7. Record the exact package versions, lockfile integrity, transitive dependency/license inventory, and supported Node.js versions.

## Ordering and safety gates

This spike is **not authorization to add libp2p to the runtime**. Execute it only after the real local keystore, cross-process provisioning gate, crash-safe identity persistence, restart/concurrency tests, and explicit recovery semantics pass on supported Windows and Linux environments.

No custom PeerId conversion, protobuf serialization, or multihash implementation is permitted. No launcher integration, transport cutover, merge, deploy, release, or database migration is authorized by this document.
