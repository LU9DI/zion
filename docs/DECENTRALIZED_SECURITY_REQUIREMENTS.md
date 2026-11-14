# Decentralized security requirements and attack-resilience plan

Status: mandatory architecture and engineering requirements. This is not a security certification and does not claim every defense is implemented.

Security must not depend on a central security service, hosted identity provider, certificate authority, central firewall, coordinator, or privileged super-node. Every node enforces local policy; project-wide security decisions are authenticated and committed by distributed governance/quorum.

## 1. Security objectives

Protect confidentiality of content, keys and private metadata; integrity of manifests, events, chunks, membership and receipts; availability under resource exhaustion, churn and partitions; isolation between projects and peers; and recovery after key loss, compromise, corruption and software defects.

Zion must never claim immunity to all attacks, perfect anonymity, complete malware detection, or guaranteed availability under arbitrary partitions.

## 2. Attacker model

Assume attackers can operate arbitrary peers and create Sybil identities; control malicious storage providers; replay, delay, reorder, drop or partition traffic; flood handshakes, signature verification, discovery, storage, repair and API paths; exploit malformed messages, parsers, archives and file paths; compromise an individual node or endpoint; steal keys; submit hostile project data; manipulate clocks; attempt rollback or log truncation; and compromise dependencies, builds, updates or maintainer accounts.

A fully compromised owner endpoint can access plaintext and keys available to it. An attacker controlling more than the protocol's declared Byzantine threshold can violate committee safety. These cases require containment and recovery, not claims of absolute prevention.

## 3. Mandatory defenses

### Identity, keys and authorization
- Peer-generated Ed25519 identities and authenticated encrypted transport. No public CA or central identity provider is mandatory.
- Keep long-term private keys out of source trees, logs, manifests and plaintext backups. Use OS or hardware-backed key stores when available, without requiring a vendor service.
- Separate node identity, project governance, content-encryption and session keys.
- Define threshold governance and recovery at project genesis; no Zion master key or single-operator recovery.
- Support signed key rotation, revocation, epoch advancement and recovery events. Reject stale capabilities and epochs.
- Enforce authorization at every operation and storage boundary. A signature proves key possession, not permission.
- Domain-separate signatures and bind signed objects to network ID, project ID, protocol version, epoch, operation, sequence and expiry as appropriate.

### Transport and protocol
- Encrypt and authenticate all remote sessions. Plaintext is loopback-development-only.
- Enforce connection caps, handshake/frame deadlines, frame/message limits, bounded queues, per-socket/per-peer/global budgets and bounded handler concurrency before expensive work.
- Apply admission and resource limits before allocating large buffers, decompressing, parsing archives, writing files or starting expensive cryptographic operations.
- Use replay protection, bounded nonce caches, idempotency and anti-amplification limits.
- Validate every schema and state transition; reject malformed encodings, non-canonical data, oversized integers, unknown critical types and invalid cross-project references.
- Treat discovery records, peer advertisements, receipts and remote metadata as hostile input. Discovery never grants trust.
- Use peer diversity and connection rotation to reduce eclipse attacks. A DHT result is not authorization.

### Consensus and partitions
- Membership, revocation, quotas, leases and governance changes require project quorum certificates.
- Select a BFT protocol with reviewed membership/epoch changes, deterministic verification, equivocation evidence and crash/restart recovery.
- Apply the 3f+1 committee and 2f+1 quorum assumptions only when validator independence and membership assumptions hold.
- Halt conflicting critical writes when quorum is unavailable. Never bypass quorum with a local leader or central fallback.
- Persist committed state before acknowledgement. Protect checkpoints against rollback and verify snapshot-to-log continuity.
- Detect and retain signed equivocation evidence; provide a governed process to rotate compromised validators.

### Storage and encryption
- Encrypt content on the owner device before transmission. Providers receive ciphertext by default.
- Use authenticated encryption with unique nonces, explicit key/version identifiers and defined rotation/recovery.
- Authenticate manifests and bind chunks to project, object, version and digest. Verify hashes on write and read.
- Use path-safe, no-follow, bounded file operations; prevent symlink/path traversal, archive bombs, decompression bombs and cross-tenant access.
- Count replicas only after independent read-back verification. Signed receipts are acknowledgements, not proof of continued possession.
- Run unpredictable replica challenges and bounded repair across independent failure domains.
- Garbage collection and reservation release require committed policy and verified replica state. Inactivity never authorizes deletion of user data.

### Denial of service and resource exhaustion
- Independent budgets for connections, unauthenticated handshakes, signature verification, messages, peer identities, memory, CPU, disk, bandwidth, transfers, repair jobs, archive expansion and project quotas.
- Bounded queues and backpressure. No unbounded promises, maps, buffers, retries or peer-controlled work.
- OS-enforced process/container CPU, memory, file-descriptor, disk and network limits where supported; application counters alone are insufficient against a compromised process.
- Per-peer/project budgets plus global emergency ceilings. Global ceilings can themselves be exhausted; expose saturation metrics and reserve capacity for recovery/control traffic.
- Exponential backoff with jitter, retry ceilings, circuit breakers and cancellation to prevent retry storms and repair amplification.
- Reject low-priority work before authorization, revocation and recovery paths are starved.
- Do not claim DDoS immunity without adversarial deployment tests and sufficient network capacity. No centralized mitigation service may be required for correctness.

### Process and project isolation
- Treat handlers, parsers, scanners, plugins and storage adapters as untrusted/failure-prone.
- Process hostile content with least privilege, no network by default, strict CPU/memory/time/file limits and isolated temporary storage.
- Separate control protocol work from bulk transfer and scanning resource pools.
- Enforce project namespaces and authorization on every read/write/delete/list operation.
- A storage peer compromise must not permit rewriting owner-authenticated manifests or accessing plaintext keys.

### Supply chain and updates
- Pin and audit dependencies; generate an SBOM; scan dependencies and artifacts; review critical transitive changes.
- Produce reproducible or independently verifiable builds where feasible. Sign release artifacts and bind signatures to source commit and build provenance.
- Require protected maintainer accounts, phishing-resistant MFA, least-privilege tokens, reviewed CI changes and secret scanning.
- Never execute update code solely because a peer advertises it. Updates require threshold-approved release metadata and local verification.
- Separate build, signing and publishing permissions. No single CI job should silently replace the protocol binary.
- Redact credentials, private keys, tokens and user content from logs.

### Malware and abuse boundaries
- Local pre-encryption scanning is bypassable by hostile clients and is not a network-wide guarantee. E2E encryption prevents providers from inspecting plaintext by default.
- Never claim comprehensive malware, illegal-content or criminal-activity detection.
- Optional inspection must document privacy trade-offs, consent, false-positive handling and retention. It cannot require a central scanning service.

## 4. Required security test program

Regression tests must cover malformed/oversized/deeply nested messages; signature forgery, identity mismatch, stale epochs, revoked peers, replay and cross-project authorization; concurrent authorization/revocation; Sybil/eclipse simulations and malicious discovery; slowloris, connection/handshake/signature floods, queue saturation and retry storms; log corruption, rollback, crash consistency and disk-full behavior; path traversal, symlinks, archive bombs, quota races and cross-tenant reads; Byzantine equivocation, committee rotation, quorum loss, partitions and restart; malicious dependencies/update artifacts and signing-key rotation.

Use property-based tests, fuzzing, sanitizers for native/Rust components, deterministic fault injection and multi-node adversarial integration tests. Unit tests and green CI are necessary, not sufficient.

## 5. Incident containment and recovery

- Nodes can locally isolate, rate-limit, quarantine or disconnect peers without a central operator.
- Project revocation is committed by governance quorum and advances authorization epochs.
- Compromised identities can be rotated; affected sessions, capabilities, leases and signing rights are invalidated or revalidated.
- Keep signed security events with bounded retention and privacy minimization.
- Recover from verified checkpoints and independent replicas, not blindly from the newest peer.
- Preserve user data during containment. Quarantine or disable access before destructive action.
- Publish advisories with affected versions, impact, mitigations and fixed versions; coordinate disclosure safely.

## 6. Mandatory release gates

A release is not production-ready until:
1. no central service is required for identity, authorization, discovery, storage, revocation or recovery;
2. all remote traffic is authenticated/encrypted and key rotation/revocation is tested;
3. quorum safety is tested under declared Byzantine threshold, partitions, equivocation and restart;
4. OS resource limits and application budgets are demonstrated under hostile load;
5. storage integrity, replica audits and recovery work across independent failure domains;
6. fuzzing, SBOM/dependency review, secret scanning and signed build provenance run in CI;
7. independent security review has no unresolved critical/high findings without an explicit approved mitigation;
8. containment and key recovery have been exercised;
9. official startup and critical operations work with hosted services blocked and no cloud credentials.

## 7. Current implementation boundary

The repository already has useful foundations: Ed25519 peer envelopes, replay protection, token-bucket admission, bounded experimental TCP transport, mutual-TLS requirements for non-loopback transport, integrity guards and local content-screening hooks. Existing SECURITY.md and docs/THREAT_MODEL.md explicitly document gaps: no validated live DHT/Kademlia network, incomplete production key/certificate lifecycle, incomplete distributed Sybil/DDoS defenses, incomplete OS-enforced resource quotas, and storage/replication paths not fully integrated into node bootstrap.

The signed local event journal adds tamper-evident local sequencing but does not provide quorum, prevent a signer from forking, or prove remote durability.

## 8. Implementation order

1. Close trust-boundary defects in peer transport, key handling, event journal and file storage; add fuzz/property tests.
2. Implement decentralized key rotation/revocation and project authorization epochs.
3. Implement the reviewed BFT quorum protocol and Byzantine/partition harness.
4. Integrate authenticated discovery, eclipse resistance and resource-bounded DHT.
5. Integrate encrypted replicated storage, independent read-back, challenges and repair.
6. Add OS-enforced resource isolation and abuse budgets.
7. Add signed/reproducible release pipeline, SBOM, dependency policy and independent review.
8. Remove central runtime dependencies only after security and recovery gates pass.


## 9. First governance implementation increment

`src/project-governance.js` adds a deterministic, project-scoped governance state machine:
- Ed25519 public keys are validated against their SHA-256-derived node IDs.
- Project genesis fixes the initial governor set and threshold.
- Proposals bind project ID, next epoch, and prior state hash.
- Distinct active governors sign the exact proposal hash; duplicate, outsider, stale, malformed, and insufficient approvals are rejected.
- Supported transitions are adding a governor, rotating a governor to a new key-derived node ID, revoking a governor, and changing the threshold.
- Revocation cannot silently leave fewer active governors than the current threshold.

This is a threshold-approval primitive, not a BFT consensus implementation. The caller must still commit the resulting transition through the project's distributed consensus, persist it safely, prevent forks/rollback, and distribute the committed certificate. Genesis trust ceremony, crash-safe state storage, network integration, and adversarial multi-node consensus tests remain outstanding.
