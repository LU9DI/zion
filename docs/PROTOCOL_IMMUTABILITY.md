# Zion Protocol Contract — draft for genesis review

**Status:** normative design draft; not yet a finalized network genesis or production certification.

## 1. Rule of compatibility

A node is compatible with the original Zion network only when it implements the exact network identifier, canonical encodings, cryptographic algorithms, required message semantics, and consensus-free validation rules defined by the adopted protocol contract. A software fork may change its local code, but cannot make conforming nodes accept those changes merely by connecting to them.

No maintainer signature alone may authorize a change to genesis parameters. Changes to immutable rules require a separately identified network/fork, unless a future governance and upgrade mechanism is explicitly ratified in the protocol before launch.

## 2. Genesis parameters

Before public launch, a canonical genesis document MUST fix and test:

- network name and immutable network identifier;
- protocol major version and canonical serialization format;
- public-key, signature, hashing, and authenticated-encryption algorithms;
- content-address and manifest formats;
- erasure-coding algorithm and parameters (the current architecture specifies k=10 data fragments and m=20 parity fragments, subject to interoperable implementation tests);
- message/frame size ceilings, mandatory validation, replay and expiry semantics;
- local and protocol-level resource limits, including any contribution ratio if the project adopts one;
- compatibility, fork, key-rotation, and revocation behavior.

Do not calculate the production NetworkID until this entire canonical parameter set is reviewed and frozen. A hash of an incomplete draft is not a secure genesis commitment.

## 3. Identity and handshake

The peer ID is derived from the canonical DER SubjectPublicKeyInfo encoding of the peer's public key. A peer proves control of that key by signing a fresh challenge bound to both peer identities, both nonces, the NetworkID, protocol version, and negotiated capabilities. The transcript must be authenticated and replay-resistant. A mismatch in NetworkID or mandatory protocol parameters MUST reject the session as incompatible.

Identity authentication is not runtime attestation: a modified program can still possess a legitimate key. Therefore every received operation MUST be independently checked against local protocol rules. Hardware-backed attestation, if ever added, is a separate optional trust layer and not a substitute for message validation.

## 4. Signed Gossip

A Gossip origin MUST sign the canonical immutable event body with Ed25519. The body includes origin ID, event type, creation time, TTL, and applicable content/peer identifiers. The event ID is SHA-256 of that same canonical body. The origin public key must derive the declared origin ID, and the signature must verify before the event is accepted. Forwarding metadata such as remaining hops may change in transit but MUST NOT alter the signed body or event ID. Unknown fields are rejected in this protocol version.

Gossip carries discovery hints only; it is not consensus and does not prove content availability. Consumers MUST independently verify provider identity, liveness, manifest authorization, and content hashes.

## 5. Invalid behavior and forks

Malformed, unauthenticated, replayed, expired, oversized, or rule-incompatible operations MUST be rejected before state mutation. Incompatible network IDs are not silently negotiated down. A single invalid packet does not automatically justify a permanent identity ban; repeated verified abuse may trigger bounded local penalties. Operators retain control over local resource ceilings, but a remote peer cannot increase them.

## 6. Release and conformance

Every release MUST have a unique version, immutable source commit, source archive hash, reproducible test report, and release signature. Published artifacts MUST NOT be silently replaced. CI conformance tests MUST include known-good and known-bad handshake vectors, canonical-encoding vectors, replay attempts, tampered Gossip events, version/network mismatches, and resource-limit violations. A passing unit suite does not certify multi-machine networking, OS-level resource enforcement, or production security.

## 7. Reference implementation status (v0.32.2)

`src/protocol-genesis.js` implements a strict schema validator, deterministic canonical JSON encoding, a domain-separated SHA-256 NetworkID, and fail-closed compatibility checks. It intentionally contains **no production genesis constants**. Tests use a disposable fixture only; its NetworkID is not a public-network identifier and MUST NOT be copied into a production release.

This code makes parameter changes detectable; it does not make a binary immutable, prove that a remote executable follows the rules, or create network-wide consensus. Each node must call compatibility checks during a real authenticated handshake and validate every operation before state mutation. The current TCP transport has not yet integrated this genesis contract or a challenge-response handshake, so the network is not ready for public exposure.

Before freezing genesis, the project must settle and review the canonical parameter values, bind them into a checked-in genesis document, add signed challenge-response handshake integration and conformance vectors, restore the full intended license text, verify builds on supported platforms, and complete multi-host/network security testing. Until then, this is a protocol-freeze implementation step, not a declaration that Zion's rules are already frozen.
