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


## Follow-up inspection: official identity ownership and persistence

Inspected `scripts/start-official-node.js` and `src/peer-security.js` at the same HEAD.

Verified:
- The official launcher requires `ZION_OFFICIAL_ADAPTER_MODULE` to point to an absolute, deployment-owned module.
- That adapter must return `identity`, and validation checks only for a non-empty `privateKey` and `nodeId`. The launcher does not define a key-file format, load/store API, atomic rotation procedure, backup/restore contract, or restart identity check.
- The official launcher also requires PostgreSQL connection configuration and a non-empty `trustedPeerIds` list. These are additional transitional centralization constraints; this transport ADR does not remove them.
- `createNodeIdentity()` generates a fresh Ed25519 keypair in memory and derives `nodeId` as SHA-256 over the SPKI DER public key. It contains no persistence operation.
- The repository's encrypted chunk store protects content chunks using a supplied 32-byte encryption key; it is not a node-identity keystore and must not be repurposed as one without a separate design.

Conclusion:
The repository establishes an identity injection boundary, but does not establish the deployment adapter's real key lifecycle. Therefore identity continuity across restart is **unverified**, not proven absent in every deployment. No adapter module or key material was inspected or changed.

Required next gate before a libp2p adapter:
1. Locate and inspect the actual deployment-owned adapter and its key persistence implementation (outside the tracked repository unless supplied).
2. Specify a versioned identity envelope and strict permissions, atomic writes, fsync, backup/restore, rotation, revocation, and recovery behavior.
3. Add tests that start, stop, and restart two independent processes and assert stable Zion node ID and stable libp2p PeerId.
4. Verify that the libp2p PeerId is cryptographically derived from the same Ed25519 key using supported APIs; otherwise define an explicit, user-visible identity migration with dual signatures and a committed transition record.
5. Design decentralized membership and bootstrap replacement in parallel: the current launcher still requires PostgreSQL and a static peer trust list. A secure Noise transport alone does not remove those dependencies.

No key files, private key bytes, deployment secrets, or external adapter configuration were accessed.
