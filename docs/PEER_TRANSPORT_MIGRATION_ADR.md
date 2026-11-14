# Peer transport migration ADR — remove CA-based trust

Status: **selected direction; implementation not started**  
Scope: PR #68, branch `architecture/fully-decentralized-core`

## Context

The current `src/peer-transport.js` is a custom newline-framed TCP protocol. Remote listeners require both a configured `trustedPeerIds` allowlist and mutual-TLS material (`key`, `cert`, and `ca`). The TLS server requests and validates client certificates. This is a transitional deployment model: the CA and operator-managed allowlist are not acceptable as mandatory trust authorities for Zion's final network.

The current package manifest has no runtime dependencies. Replacing the transport is therefore a protocol and lifecycle migration, not a small TLS-option change. The existing application framing, rate limits, connection caps, admission checks, integrity quarantine, deadlines, and handler lifecycle must not be lost.

## Decision

Adopt the maintained **js-libp2p stack with the libp2p Noise connection encrypter** as the target peer transport, rather than implementing a Noise handshake or cryptographic channel in Zion.

Initial transport profile to evaluate and pin in a dedicated implementation change:

- `libp2p` for the Node.js peer runtime;
- `@libp2p/tcp` for the initial TCP transport;
- `@libp2p/noise` for authenticated encrypted channels and forward secrecy;
- `@libp2p/yamux` for stream multiplexing;
- `@libp2p/identify` for exchanging peer identity/protocol metadata;
- `@libp2p/kad-dht` in a later discovery increment, not required to land with the secure-channel adapter.

The transport's authenticated peer ID must be derived and verified by the libp2p handshake. Project authorization remains a separate decision based on Zion's committed project membership and authorization epoch. A successful Noise handshake must never imply project admission.

The existing Ed25519 identity format must be mapped to libp2p's identity representation through supported library APIs. Do not hand-roll key conversion, peer-ID encoding, certificate handling, or Noise primitives. Preserve identity continuity only if a tested, documented conversion proves the same key material and stable peer identity; otherwise define an explicit versioned identity migration before rollout.

## Why this direction

The official libp2p documentation describes Noise as a secure channel that authenticates peer IDs and provides forward secrecy. Its JavaScript implementation supports Node.js TCP connectivity and provides maintained modules for Noise, TCP, Yamux, Identify, and Kademlia DHT:

- https://libp2p.io/docs/noise/
- https://libp2p.io/docs/secure-channels-overview/
- https://libp2p.io/docs/standalone-connectivity/
- https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md

This reuses a specified, interoperable P2P stack instead of introducing a custom cryptographic protocol. It also creates a coherent path to optional peer discovery, peer exchange, and NAT traversal without making any bootstrap peer mandatory.

## Required invariants

1. No public CA, hosted identity provider, centralized certificate issuer, or operator allowlist is required for network correctness.
2. Every remote connection is encrypted and mutually authenticates cryptographic peer identities before application messages are accepted.
3. Peer discovery is only a source of untrusted addresses. It never grants authorization.
4. Project membership, revocation, and capability checks remain bound to the latest committed project epoch; no stale peer-book entry overrides them.
5. The node can operate with manually exchanged peer addresses and previously persisted peer records when DHT or all seed peers are unavailable.
6. Seed peers are optional and replaceable. No single seed, DHT operator, relay, or provider is authoritative.
7. Existing resource protections remain effective: global and per-peer rate budgets, maximum connections, bounded queues and frames, handshake/frame/handler deadlines, cancellation, quarantine, and bounded shutdown.
8. Application protocol messages retain explicit schema/version validation, replay protection, and bounded payload sizes.
9. The migration does not silently fall back to plaintext TCP or CA-backed TLS if Noise setup fails. It fails closed.
10. Existing storage and project-event replication semantics remain above the transport abstraction and are not coupled to a particular peer address or relay.

## Migration plan

### Phase A — compatibility spike

- Pin mutually compatible, reviewed package versions and commit the lockfile.
- Verify Node.js >=20 support for the exact versions selected.
- Build a minimal two-process TCP Noise handshake using the supported APIs.
- Prove mutual peer-ID authentication, encrypted stream transfer, wrong-peer rejection, malformed-handshake rejection, and stable identity persistence/restart.
- Confirm that the existing Ed25519 node identity can be represented safely, or specify a versioned migration.
- Record package provenance, license, transitive dependency audit, and upgrade policy.

### Phase B — transport adapter

- Introduce a transport adapter preserving the existing application-level send/receive contract.
- Move PING/PONG and project-event replication through authenticated libp2p streams.
- Keep the existing custom transport available only to legacy tests during migration; never allow it as an official remote-network fallback.
- Port and retain all resource limits, admission preflight, replay handling, handler deadlines, integrity quarantine, and shutdown race tests.
- Add cross-process tests; in-process loopback tests alone are insufficient.

### Phase C — decentralized discovery

- Add optional Kademlia DHT, bounded peer exchange, and local-network discovery.
- Treat all discovered multiaddresses and peer records as untrusted until cryptographically authenticated.
- Support multiple independently operated seed peers as optional hints; test startup and reconnection with every seed unavailable.
- Add peer diversity, address-family and network-prefix controls, eclipse simulations, and bounded routing-table persistence.
- Evaluate relay/NAT traversal separately. A relay may forward ciphertext but must not become an authorization or decryption authority.

### Phase D — cutover

- Require all official-mode nodes to use the new secure transport.
- Prove no-CA startup and node-to-node operation with hosted services unavailable.
- Remove CA and static allowlist requirements from the official runtime only after compatibility, restart, partition, and adversarial tests pass.
- Retain legacy support only if explicitly isolated from official mode and documented as non-production; do not silently downgrade.

## Mandatory test gates

- Two independent Node.js processes establish Noise sessions over TCP with no CA or central service.
- Both peers authenticate the intended peer IDs; wrong keys and key substitution are rejected.
- Application payloads are encrypted in transit and tampering is detected.
- Handshake floods, slow handshakes, oversized frames, queue floods, connection churn, and resource exhaustion remain bounded.
- Replay, stale project epoch, revoked membership, and unauthorized project operations are rejected even after a successful transport handshake.
- Process restart preserves the node identity and can reconnect without a hosted service.
- DHT and all configured seeds can be unavailable without breaking existing peer-book connectivity.
- Official mode refuses plaintext or legacy CA fallback.
- Cross-version and cross-implementation interoperability is tested before protocol version changes are accepted.

## Non-goals

- This ADR does not implement BFT consensus, quorum certificates, DHT, relay, storage durability proofs, or project membership itself.
- This ADR does not claim that Noise alone prevents Sybil, eclipse, DDoS, malicious peers, or compromised endpoints.
- This ADR does not authorize merging PR #68, deploying, releasing, or applying database migrations.

## Current status

The existing custom TCP + mutual-TLS/CA path remains transitional. No libp2p dependencies have been added and no Noise implementation is claimed. The next code increment must be the Phase A compatibility spike with pinned dependencies and reproducible cross-process tests, before any official transport cutover.
