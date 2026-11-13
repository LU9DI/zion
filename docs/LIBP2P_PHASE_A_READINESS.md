# libp2p Phase A readiness assessment

Status: **inspection only; no transport implementation or dependency change**  
Scope: PR #68, branch `architecture/fully-decentralized-core`

## Verified repository facts

At HEAD `65663060351e95d0b1b3d173cd575c33f0251208`:

- `package.json` declares ESM (`"type": "module"`) and Node.js `>=20`, with no runtime dependencies or package lockfile.
- `src/peer-transport.js` implements custom newline-framed TCP and optional mutual TLS. A non-loopback listener currently requires both `trustedPeerIds` and TLS key/certificate/CA material. The transport also owns important safeguards: connection caps, frame and queue bounds, rate limiters, replay guard, handshake/frame/handler deadlines, integrity quarantine, admission preflight, and coordinated shutdown.
- Official mode currently requires a protocol genesis and an IntegrityGuard. Admission-controller configuration additionally requires a non-empty trusted-peer bootstrap allowlist.
- `createNodeIdentity()` in `src/peer-security.js` generates an Ed25519 keypair, exports the public key as SPKI PEM, and defines Zion's current node ID as SHA-256(SPKI DER). It returns the private key object, but this function itself does not persist it.

## Compatibility findings

The current Zion node ID is a project-defined 32-byte SHA-256 digest. It must not be assumed to equal a libp2p PeerId. A migration must explicitly compare the identity encodings and prove whether the exact Ed25519 keypair can be imported through supported js-libp2p APIs while preserving a stable peer ID. No ad-hoc conversion or silent identity replacement is acceptable.

The identity persistence lifecycle is not established by `createNodeIdentity()` alone. Before implementation, trace every caller, serialization format, key storage location, backup/restore path, and restart behavior. If private keys are currently regenerated or stored elsewhere, the adapter must honor the actual lifecycle and must never log or expose private key bytes.

The current transport is not merely a socket wrapper. Replacing it requires an adapter boundary and explicit mapping for:
- authenticated remote peer identity and application-level Zion node ID;
- message framing, protocol negotiation/versioning, and operation dispatch;
- authorization preflight and committed project membership epochs;
- global/per-peer/socket rate budgets and connection/stream limits;
- bounded queues, frame sizes, deadlines, cancellation, quarantine, and shutdown;
- replay protection and application-level signed-message verification.

A successful Noise handshake authenticates the transport peer identity; it does not replace project admission, revocation, or operation authorization.

## Verified js-libp2p configuration model

The upstream js-libp2p configuration guide documents a modular configuration with required transports and connection encryption, and optional stream multiplexers, discovery, and services. It shows the supported composition pattern using `createLibp2p()`, `tcp()`, `yamux()`, and `noise()`. Identify is a service used by DHT routing and other discovery features; Kademlia DHT is a separate optional service. Do not add DHT to the first secure-channel spike.

Reference: https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md

## Phase A execution gate

Do not add packages until a reproducible spike can be run in an isolated worktree or CI branch with a committed lockfile and pinned compatible versions. The spike must:

1. Build two independent Node.js processes using TCP + Noise + Yamux, with no CA, hosted identity service, or required bootstrap node.
2. Persist each node identity and prove the same peer identity survives process restart.
3. Prove both peers authenticate the expected remote identity; wrong keys, key substitution, and malformed handshakes fail closed.
4. Exchange bounded application frames over a negotiated Zion protocol stream; reject oversized, malformed, replayed, stale-epoch, and unauthorized messages.
5. Exercise slow handshakes, connection churn, oversized frames, queue saturation, handler timeouts, cancellation, and shutdown.
6. Demonstrate that no code path silently downgrades to plaintext or legacy CA-based remote transport.
7. Produce a dependency inventory, license review, provenance record, and vulnerability scan for the exact lockfile.

## Explicitly unresolved

- Exact compatible package versions and transitive dependency graph.
- Whether the existing Ed25519 key format can be imported with stable libp2p PeerId continuity.
- Where and how production node identities are persisted, restored, rotated, and revoked.
- Whether the current admission/genesis design can operate without the static trusted-peer bootstrap allowlist.
- How to retain every existing transport resource guard with libp2p connection/stream APIs.

These are blockers to the adapter implementation, not reasons to weaken the decentralization requirement. No implementation, package installation, lockfile, migration, merge, or deployment is claimed by this assessment.
