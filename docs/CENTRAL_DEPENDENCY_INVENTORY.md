# Central dependency inventory — Zion

Status: **source audit for the fully decentralized migration; not a claim that replacements are implemented**.

Audit base: the code lineage currently represented by PR #64 head 839a46ad060715b600c55a620fc993961e0c0407. The separate draft PR #68 defines the target architecture. PRs #63 and #64 are not modified by this inventory.

## Confirmed central runtime dependency

### Official node startup

- scripts/start-official-node.js imports createPostgresPeerAdmissionRuntime from the PostgreSQL runtime module.
- startOfficialNode requires ZION_POSTGRES_URL or DATABASE_URL.
- It requires a deployment adapter that creates a node-postgres-compatible pool and passes it into the PostgreSQL admission runtime.
- It validates a non-empty trusted peer allowlist supplied by the deployment adapter.
- docs/POSTGRES_PEER_ADMISSION_RUNTIME.md and docs/OFFICIAL_POSTGRES_NODE_LAUNCHER.md describe PostgreSQL as a required official-node dependency and require the peer-admission migration.
- src/peer-admission-postgres-store.js uses PostgreSQL transactions, row locks, advisory locks, and durable tables as the authoritative peer-admission/revocation state.

**Conclusion:** the current official launcher is centrally dependent. It cannot satisfy the no-exceptions requirement. It must be replaced by a peer-quorum-backed admission/authorization runtime before the official node can be called decentralized.

## Other central persistence work in the current draft chain

The later draft work must be treated as transitional until redesigned around replicated peer state:

- PR #65 adds project inactivity/resource-policy schema and an experimental lifecycle controller.
- PR #66 adds a PostgreSQL project-resource repository and a sweep runner requiring a PostgreSQL URL and deployment adapter.
- PR #67 adds PostgreSQL storage accounting/quota schema.
- These drafts are not merged and must not be silently treated as active runtime enforcement.

The 7-day pause and 15-day reservation-release product policy remains valid. Its authority and scheduler must move to committed project events and peer-quorum transitions; no hosted scheduler or central database may be required.

## Existing decentralized building blocks

The repository already contains useful components, but they are not an end-to-end decentralized network:

- Ed25519 peer identities and signed protocol messages.
- Experimental bounded TCP transport; official remote mode currently depends on mutual TLS and an operator-provisioned trust allowlist.
- DHT provider-discovery adapter boundary and a libp2p ContentRouting wrapper, but no installed/live libp2p network or deployed Kademlia DHT.
- Opaque ciphertext replica storage and a replication coordinator.
- Signed replication receipts, which the code itself correctly treats as acknowledgements rather than proof of continued availability.
- A Rust local content-addressed storage sidecar, not yet wired as an out-of-the-box replicated storage path.
- A local file-backed peer-admission state store, useful for single-node persistence but not a distributed consistency mechanism.

## Required replacement map

| Existing central seam | Required decentralized replacement |
|---|---|
| PostgreSQL admission store | Project-scoped committed membership/revocation log with quorum certificates |
| PostgreSQL advisory-lock authorization fence | Epoch-bound authorization proofs checked against committed state; stale epochs rejected |
| PostgreSQL LISTEN/NOTIFY revocation listener | Authenticated bounded peer gossip for prompt cache invalidation; durable quorum state remains authoritative |
| Trusted peer allowlist | Genesis-governed membership and threshold-approved epoch transitions |
| PostgreSQL project lifecycle repository | Replicated activity/resource event log and quorum-committed lifecycle state |
| Hosted/central sweep scheduler | Deterministic bounded evaluation by multiple peers; quorum prevents conflicting transitions |
| PostgreSQL storage quotas | Quorum reservations reconciled with signed provider capacity receipts |
| Static bootstrap allowlist | Multiple optional seed peers, peer exchange, DHT and local/out-of-band bootstrap |
| Mutual TLS CA trust | Peer-key authentication and encrypted Noise sessions with key rotation/revocation governed by protocol epochs |

## Migration order and guardrails

1. Implement the local durable signed event log and a deterministic project state machine.
2. Define and test a storage-neutral admission/authorization contract.
3. Implement the project-scoped BFT commit protocol and quorum evidence.
4. Replace the official launcher so it starts without DATABASE_URL, ZION_POSTGRES_URL, or a PostgreSQL adapter.
5. Integrate peer discovery and encrypted peer transport; no single seed or CA is mandatory.
6. Move inactivity, leases, quotas, and storage accounting onto the same committed project state.
7. Run two-or-more-node, restart, partition, Byzantine-fault, revocation-race, and capacity-concurrency tests.
8. Prove the official runtime works while all hosted services are blocked and no database credentials exist.
9. Only after parity and recovery evidence, remove PostgreSQL from official runtime and required CI. Keep historical migrations/compatibility adapters until their removal is separately reviewed.

## Acceptance checks for this audit

- [x] Identified the official launcher PostgreSQL dependency.
- [x] Identified the current authoritative admission store.
- [x] Identified PostgreSQL lifecycle/quota work in draft PRs #65–#67.
- [x] Identified existing P2P/storage building blocks and their stated limits.
- [ ] Decentralized replacement implemented.
- [ ] Official node starts without any central service.
- [ ] Multi-node quorum and partition tests pass.
- [ ] Hosted-service outage test passes.
