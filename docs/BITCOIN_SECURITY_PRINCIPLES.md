# Bitcoin-inspired security principles (adapted, not copied)

REA Cloud borrows security principles from Bitcoin's peer-to-peer design, not Bitcoin's monetary system or proof-of-work consensus.

## Adopted principles

- **Don't trust, verify:** every peer message is schema-checked and cryptographically authenticated; remote claims are not treated as proof that a block exists.
- **Public-key identity:** Ed25519 keypairs identify nodes; a node ID is derived from the public key. This proves control of a key, not that one human owns only one node.
- **Replay resistance:** signed messages carry a timestamp and random nonce. A bounded replay cache rejects duplicate nonces. Expiration is maintained by a min-heap, avoiding a full cache scan on every accepted message. Distributed deployments must persist or partition replay state appropriately.
- **Rate limits:** token buckets reduce noisy-peer impact. They are local admission controls, not a complete DDoS defense.
- **Content integrity:** chunk identifiers are SHA-256 digests; ciphertext is authenticated before plaintext is returned.
- **Peer independence:** replication should span independently operated failure domains; multiple bootstrap peers are preferable to one mandatory coordinator.
- **Local verification:** node policies are enforced locally and remote messages cannot raise owner resource limits.
- **Small, auditable protocol:** explicit protocol versions and bounded message sizes make upgrades and review safer.

## Deliberately not adopted

- **No proof-of-work:** storage providers should not burn CPU or electricity to prove participation; that conflicts with the no-perceptible-impact requirement.
- **No global blockchain or consensus for each file:** ordinary storage placement does not require a globally replicated ledger. Signed manifests and independent verification are more proportionate.
- **No assumption that public-key identity prevents Sybil attacks:** an attacker can generate many keys. Later defenses need diversity across networks/failure domains, admission economics or reputation with carefully analyzed tradeoffs, and eclipse-resistance testing.
- **No claim of Byzantine fault tolerance yet:** this repository is a prototype and does not implement a production P2P transport or distributed consensus.

## Security caveats

Ed25519 identity keys are generated in memory by the current helper; secure persistence, rotation, revocation, trust-on-first-use, and identity recovery are not implemented. ReplayGuard is bounded in-memory state and must be integrated after signature validation; it is not durable across restarts. Canonical serialization is internal to this protocol version and requires test vectors before interoperability. Do not expose this prototype to untrusted public peers yet.

## Signed manifests (REA-specific adaptation)

REA manifests now bind an owner node ID to a public key and an Ed25519 signature over a canonical description of encrypted chunks. Verification rejects malformed chunk IDs, duplicate chunk IDs, size mismatches, oversized manifests, identity substitution, and signature tampering. This is inspired by Bitcoin's verify-before-trust model; it is not Bitcoin consensus and does not prove that a peer is honest or that a file has enough replicas.

## Resource-exhaustion safeguards

The per-peer token bucket has a hard peer-cardinality limit and idle expiry. When its bounded table is full, new identities are rejected rather than evicting active buckets and allowing an attacker to reset rate limits. This is local admission control only; it does not prevent distributed denial of service by itself.
