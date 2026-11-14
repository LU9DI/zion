# Zion fully decentralized core — architecture decision

Status: **architecture target; implementation and production readiness are not claimed**.

This document defines a hard product invariant: Zion must operate without any mandatory central service. It is not an optional deployment profile. A node must be able to start, discover peers, authenticate, authorize, store, retrieve, recover, and coordinate project operations without Neon, PostgreSQL, a hosted control plane, a single bootstrap server, a certificate authority, a cloud object store, or a single privileged operator.

The design deliberately avoids a blockchain, native token, mining, and global consensus. Consensus is scoped to the smallest unit that needs shared, strongly consistent state.

## 1. Non-negotiable invariants

1. **No central runtime dependency.** No network-critical path may require a hosted database, API, scheduler, identity provider, CA, DNS provider, cloud bucket, or operator-controlled coordinator.
2. **No unilateral authority.** No node, organization, provider, or operator can unilaterally admit/revoke peers, change project policy, claim storage capacity, or release another peer's reservation.
3. **No hidden central fallback.** If peer quorum is unavailable, critical mutations wait or fail closed. They must not silently fall back to a hosted database or a privileged node.
4. **Independent local operation.** Every node persists its own durable state locally and can restart without a remote control plane. Shared state is reconciled through authenticated peer protocols.
5. **End-to-end confidentiality.** Content is encrypted by the client before leaving the owner device. Storage peers receive ciphertext and cannot decrypt it by default.
6. **Verifiable storage.** Placement plans and signed acknowledgements are not durability proof. A replica counts only after read-back verification and subsequent challenge/audit evidence.
7. **No global consensus for ordinary data.** Consensus is limited to project membership, authorization epochs, leases, quota reservations, and other operations where conflicting decisions would create a security or accounting failure.
8. **No destructive inactivity automation.** The 7-day pause and 15-day reservation-release policy must preserve user data. Releasing capacity is not permission to delete content.

## 2. Minimal network topology

Each node runs the same protocol implementation and can act as a client, peer, and storage provider according to locally configured resource limits.

- **Peer transport:** authenticated encrypted sessions using peer-held cryptographic identities and a Noise-based handshake. The current mutual-TLS transport remains a transitional implementation, not the final trust model; a public CA must not become a network dependency.
- **Discovery:** Kademlia-style DHT plus bounded peer exchange and local-network discovery. Discovery responses are untrusted hints and never confer authorization.
- **Bootstrap:** several independently operated seed peers may improve first contact, but none is mandatory or authoritative. Nodes may also join from a locally supplied peer address or a previously saved peer book. A seed outage must not disconnect nodes that already know peers.
- **Peer book:** signed, bounded, locally persisted observations with expiry, diversity limits, and backoff. A peer cannot make itself trusted by advertising itself.
- **No single naming service:** network and project identifiers derive from cryptographic genesis material; discovery can resolve identifiers through multiple peers.

A completely new isolated node still needs at least one initial peer address or an out-of-band peer-book exchange to reach an existing network. This is an information-theoretic bootstrap fact, not a central-service exception: the address can be supplied by any participant and no single address is required by the protocol.

## 3. Identity, membership, and governance

- Each node identity is a locally generated Ed25519 key pair. The node ID is derived from its public key.
- Project identity derives from a project genesis record. The genesis record defines the initial governance threshold, protocol version, and initial peer set.
- Governance changes are signed events. High-impact changes require a threshold of independent project governance keys; no single online node has unilateral authority.
- Membership and revocation are epoch-based. A revocation advances the project authorization epoch; stale capabilities and stale membership views are rejected.
- Peers prove possession of their identity key during session establishment. Transport authentication does not by itself grant project access.
- Project capabilities are scoped, short-lived, signed, and checked against the latest committed authorization epoch.
- Governance-key recovery must use a threshold recovery policy defined at project creation. No Zion-operated recovery server or universal master key is allowed.

### Sybil and eclipse resistance

A public permissionless network cannot obtain strong Sybil resistance from signatures alone: creating more key pairs is cheap. Zion must not claim otherwise. The initial practical policy is project-scoped admission with threshold-approved membership, peer diversity, connection/rate budgets, bounded gossip, and auditable resource commitments. Proof-of-storage and challenge-response can support capacity claims, but do not alone establish a unique real-world person or prevent collusion. Any future open-admission policy must be threat-modelled and tested before being enabled; it must not depend on a central identity provider or token economy.

## 4. Distributed state and consensus

Use **project-scoped Byzantine fault-tolerant state-machine replication**, not one global chain.

- Each project has a validator committee derived from its committed membership and governance policy. Validator eligibility and operator-independence assumptions are a separate blocking design gate: see [DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md](DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md). Distinct public keys, peer discovery, and VRF selection do not by themselves provide Sybil resistance. Genesis governor trust, recovery, and safe committee rotation are separately gated by [PROJECT_GENESIS_AND_VALIDATOR_ROTATION_SPEC.md](PROJECT_GENESIS_AND_VALIDATOR_ROTATION_SPEC.md).
- Membership changes are committed as epoch transitions. Committee selection and rotation are deterministic and recorded so peers can independently verify them.
- A state transition is committed only with a quorum certificate from the configured committee. For a committee of 3f + 1 validators, the protocol requires 2f + 1 votes to tolerate up to f Byzantine validators, subject to the committee-selection and independence assumptions.
- The proposer rotates. No permanent leader or coordinator is authoritative.
- Every committed transition includes the previous state/event digest, project ID, epoch, sequence, operation, and quorum evidence.
- Nodes persist committed log entries before acknowledging them and replay the log after restart.
- A conflicting or stale quorum certificate is rejected. Safety takes priority over availability during a partition: operations requiring quorum stop rather than split-brain.
- Reads may be local and explicitly marked stale; authorization, revocation, quota, and lease decisions require current committed state.

Do not introduce a token, mining, a public chain, or global cross-project consensus. The exact BFT protocol and implementation library must be selected only after an adversarial protocol review and reproducible safety/liveness tests. Raft alone is not sufficient for an open or Byzantine peer set.

## 5. Data model and storage

- The owner client encrypts file content before upload. The existing AES-256-GCM envelope may remain during migration; key sharing/recovery must be designed separately and must never place plaintext keys in manifests or storage nodes.
- Encrypted chunks are content-addressed. The hash identifies ciphertext, not plaintext.
- A project manifest is versioned and authenticated. Concurrent edits produce explicit versions/conflicts; no storage peer can silently rewrite owner-authenticated content.
- Placement uses independent failure domains and local capacity commitments. A single provider cannot claim multiple independent replicas.
- A storage receipt binds project, chunk digest, exact byte count, target peer, request nonce, and expiry. Receipt issuance follows write plus read-back verification.
- Periodic unpredictable challenges re-check replica possession. Failed audits mark a replica suspect and trigger bounded repair; they do not silently count the replica as healthy.
- Repair and garbage collection are bounded, jittered, idempotent, and governed by committed retention rules.
- Each node uses a local durable store for its own log, peer book, and ciphertext. There is no shared database. Replication of project metadata occurs through the project protocol.
- Quota reservations are committed by project quorum and reconciled against signed provider capacity receipts. Concurrent requests cannot allocate the same capacity twice.

## 6. Inactivity and abuse policy

The existing product decision remains: pause a project after 7 days without verified meaningful activity and begin releasing storage reservations after 15 days. The clock is based on the last meaningful event, not scheduler execution time.

The distributed implementation must:
- replicate meaningful activity as authenticated, idempotent project events;
- exclude heartbeats, telemetry, scans, replication, retries, and dashboard polling from meaningful activity;
- commit pause and reservation transitions through project quorum;
- verify relocation and replica evidence before releasing a provider's capacity;
- re-check activity, leases, and policy epoch immediately before release;
- never delete user data as a side effect of inactivity;
- permit owner reactivation only after capacity and authorization are revalidated.

The PostgreSQL lifecycle controller/repository in the existing draft work is not the final implementation and must not become a runtime requirement.

## 7. Content screening and privacy boundary

Client-side malware screening before encryption is a useful safeguard but is bypassable by hostile clients and is not a network-wide guarantee. Storage peers cannot inspect E2E-encrypted plaintext without receiving decryption capability. Zion must describe these limits honestly. Any optional inspection design must make its privacy trade-off explicit and cannot introduce a central scanning service as a required dependency. Malware screening is not comprehensive detection of illegal or criminal content.

## 8. Explicitly prohibited architecture

- Neon, hosted PostgreSQL, or any centralized database as a required source of truth.
- A single control-plane API, scheduler, coordinator, or privileged super-node.
- A mandatory bootstrap endpoint, DNS provider, cloud bucket, hosted CA, or identity provider.
- A global blockchain, native token, mining, or proof-of-work requirement.
- Silent fallback from unavailable peer quorum to a central service.
- Treating a signed receipt, planned placement, or a single peer assertion as proof of durable storage.
- Claiming Sybil resistance, global availability, or production readiness without adversarial evidence.

## 9. Migration plan

The migration is additive and must preserve existing work until replacements pass tests.

1. **Inventory and boundary:** enumerate every runtime import, launcher, migration, environment variable, and test that requires PostgreSQL or a hosted service. Classify it as local-only, transitional, or forbidden in the final runtime.
2. **Contracts:** define storage-neutral interfaces for committed project state, membership, authorization epochs, leases, quotas, activity log, and peer discovery. Existing PostgreSQL adapters may implement these interfaces for compatibility tests only; they cannot be required by the official node.
3. **Local durable event log:** implement append-only, signed, replayable project events and crash/restart recovery on each node.
4. **Peer replication:** exchange and validate events between independent nodes; test duplicate, reordered, delayed, conflicting, and malicious messages.
5. **BFT commit path:** add project-scoped quorum certificates, rotating proposers, epoch changes, and fail-closed partition behavior.
6. **P2P transport/discovery:** integrate authenticated encrypted peer sessions, DHT, peer exchange, bootstrap diversity, and NAT traversal without a mandatory seed.
7. **Storage lifecycle:** connect encrypted chunk transfer, read-back receipts, challenge audits, repair, and quota reservations to committed project state.
8. **Cutover evidence:** prove startup, authorization, upload, retrieval, revocation, restart, node loss, partition recovery, and project lifecycle with all hosted services unavailable.
9. **Removal:** only after parity and recovery are demonstrated, remove PostgreSQL/Neon from the official runtime, deployment configuration, and required CI path. Do not delete historical migrations or compatibility tests until their removal is separately reviewed.

## 10. Mandatory acceptance gates

The architecture is not complete until automated tests demonstrate:

- official node startup with no database URL, cloud credentials, or hosted service reachable;
- two or more independent nodes exchanging peers and project state without a fixed bootstrap server;
- quorum authorization and revocation under concurrent requests;
- no conflicting commits under partitions, message reordering, duplicate delivery, or Byzantine test nodes within the declared fault threshold;
- fail-closed critical writes when quorum is absent;
- restart recovery from local durable logs;
- ciphertext upload, verified replica read-back, challenge failure, and bounded repair;
- no double allocation under concurrent quota/lease requests;
- no data deletion when the 7/15-day inactivity lifecycle runs;
- successful recovery after peer churn and loss of one failure domain;
- a dependency audit proving no central service is required by the official runtime.

Passing unit tests alone is not production certification. Public-network release still requires independent protocol/security review and deployment evidence.


## 11. First implementation increment — local signed event journal

The branch now contains `src/signed-project-event-log.js` and `test/signed-project-event-log.test.js`. The journal provides a node-local append-only JSONL log with Ed25519-signed events, per-node sequence numbers, previous-record hash chaining, bounded size/count, serialized concurrent appends, fsync before acknowledgement, single-process exclusive locking that fails closed on any existing lock and requires explicit operator recovery; automatic stale-PID lock deletion is disabled, and fail-closed startup on truncated or tampered records. It rejects a journal signed by a different node identity.

The signed event journal now has a one-hop adapter over the existing authenticated `PeerTransport`: `PROJECT_EVENT_REPLICATION` carries a bounded signed record, the receiver verifies that the event signer is the authenticated transport peer, applies the replica's project-scoped authorization callback, persists before acknowledging, and returns an authenticated idempotency ACK. The sender helper only transmits records signed by its own node identity. Historical signed events remain syncable after a peer has been offline; the inner event timestamp has no maximum age, while future clock skew remains bounded. The outer authenticated transport message still enforces freshness and replay protection. The protocol validator bounds the frame shape and size. Relaying third-party records, durable ACK tracking/retries, peer discovery, and consensus are not implemented by this adapter.

The branch also contains `src/signed-project-event-replica.js`, a durable receiver for signed per-node journal records. It authenticates each record, calls an explicit project-scoped peer-authorization policy, enforces contiguous per-signer sequence/hash chains, deduplicates exact replays, rejects conflicting same-sequence records, bounds stored bytes/records, and fsyncs before acknowledging. Startup replays and verifies the durable replica journal and fails closed on corruption or truncation. Tests cover authorized ingestion, out-of-order delivery, replay, unauthorized peers, equivocation, restart recovery, truncation, and capacity limits. This is a durable observation/replication store only: it does not prove a peer remains authorized after the policy changes, issue quorum certificates, select committed events, or provide network transport.

This is deliberately **not** a distributed commit protocol: a local signature and hash chain do not prove quorum agreement, prevent a malicious signer from forking its own log, or establish global ordering. The journal is a durable substrate for later peer replication and quorum certificates. It is not yet wired into the official node launcher or project authorization path. Tests are committed but their CI result must be checked before treating them as passing.


## 13. Project BFT commit protocol design gate

The next consensus design constraints and adversarial acceptance requirements are recorded in [PROJECT_BFT_COMMIT_PROTOCOL_SPIKE.md](PROJECT_BFT_COMMIT_PROTOCOL_SPIKE.md). Governance threshold approvals, authenticated transport sessions, signed event records, replica acknowledgements, and storage receipts are not BFT commit certificates. The validator committee, fault model, quorum rules, anti-equivocation persistence, view changes, and safe epoch reconfiguration must be selected and reviewed before implementing consensus. No BFT protocol is selected or implemented by this document.

## 12. Mandatory security requirement

Zion's security baseline and release gates are defined in [DECENTRALIZED_SECURITY_REQUIREMENTS.md](DECENTRALIZED_SECURITY_REQUIREMENTS.md). This is a hard requirement of the fully decentralized architecture: peer identity/key lifecycle, encrypted transport, authorization epochs, BFT safety, anti-replay, bounded resource use, Sybil/eclipse resilience, storage integrity, process isolation, supply-chain security, incident containment, and adversarial testing. No central CA, identity provider, DDoS service, or privileged operator may be required for correctness. The requirements document distinguishes implemented foundations from missing defenses; it is not a claim of current security certification.


## 14. Decentralized admission and authorization contract

The source-derived migration contract in [DECENTRALIZED_ADMISSION_AUTHORIZATION_CONTRACT.md](DECENTRALIZED_ADMISSION_AUTHORIZATION_CONTRACT.md) defines the state, atomic transitions, revocation tombstones, dispatch authorization boundary, quota/capacity semantics, and acceptance gates required before PostgreSQL can be removed from official runtime. It does not implement a replacement or authorize launcher cutover.
