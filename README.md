# Zion v0.33.32 — Experimental decentralized storage foundation

**Status: research prototype; not production-ready and not a public P2P cloud.** The repository contains local storage/crypto primitives, resource-policy logic, signed Witness recovery, an experimental bounded TCP transport, and an illustrative cloud UI. The license text is now present as AGPL-3.0-only.

## Quick status

- **Available for local experiments:** Node.js modules and automated tests; the cloud UI is a local-only preview.
- **Not wired as a complete network:** no running libp2p/Kademlia deployment, bootstrap network, NAT traversal, or validated internet connectivity.
- **Storage caveat:** the Rust storage core is opt-in and not integrated into the active JavaScript replica path. The default in-memory ciphertext adapter is for tests/demos; a durable authenticated adapter is required for real use.
- **Security caveat:** remote peer transport now fails closed unless mutual TLS key/certificate/CA material is configured, but certificate lifecycle/trust distribution, production key management/key sharing, distributed Sybil/DDoS defense, and cross-platform hard resource quotas remain incomplete. CI also performs a real mutual-TLS handshake using ephemeral test certificates and checks rejection of an untrusted CA; this is not a substitute for production certificate operations. Plaintext transport is restricted to loopback. Do not store sensitive data or the only copy of important files.
- **Witness caveat:** recovery depends on an integrator-supplied live-session validator and trusted publisher keys. Local signatures and fsync calls do not prove an external authority or device-level durability.
- **Validation:** The baseline suite previously passed 168 JavaScript module syntax checks, 533 Node tests, both demos, and 3 Rust tests. The newer mutual-TLS integration tests also passed in [validation run for commit `e9e8bd9`](https://github.com/LU9DI/zion/actions/runs/38066430962). Check the [latest Actions runs](https://github.com/LU9DI/zion/actions) for the current branch status.

## Local verification

Requires Node.js 20 or newer:

```sh
npm run check
npm test
npm run demo
npm run client:demo
```

The test suite verifies prototype behavior; passing tests do not certify a secure public network, production deployment, power-loss durability across filesystems, or resistance to a coordinated distributed attack.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [SECURITY.md](SECURITY.md), and [AUDIT_CURRENT_ZION.md](AUDIT_CURRENT_ZION.md) for implementation boundaries and remaining blockers.

Consumer apps can call `ZionClient.upload()` and `ZionClient.download()` rather than orchestrating encryption and chunking directly. The client screens input locally, encrypts chunks with AES-256-GCM before passing them to a pluggable storage adapter, and keeps the file key outside the manifest. Do not use the in-memory adapter for real data. Automatic key sharing and ZKP are not implemented.

## Historical release notes

The sections below preserve older version notes and audit history; they are not a claim that every historical feature is wired into a production network.

# Zion v0.33.17 — Witness crash-boundary publication safety

- O adaptador de checkpoint mantém corrupção em estado fechado: checkpoint comprometido inválido não é sobrescrito automaticamente.
- Bloqueios existentes, abandonados ou substituídos não são removidos automaticamente quando a propriedade não pode ser provada.
- O teste adicional verifica o modo privado `0600` do lock enquanto ele está adquirido; o checkpoint também é criado com modo `0600` em sistemas compatíveis.
- A publicação usa arquivo temporário, `fsync` do arquivo e sincronização do diretório pai; falhas de durabilidade são reportadas explicitamente.
- Consulte [`AUDIT_V0.33.17.md`](AUDIT_V0.33.17.md) para comandos reproduzíveis e limites da auditoria.

**Limites:** testes locais não comprovam exposição pública segura, configuração real de certificados TLS, semântica de filesystem distribuído ou resistência a rollback de snapshots. Nenhum deploy nem publicação no GitHub é declarado.

---

## v0.33.2 — Rotação de credenciais e auditoria segura

- O serviço recarrega o arquivo de credenciais a cada requisição autenticada, permitindo rotação e revogação sem reiniciar o processo.
- Formato JSON suportado: `{ "schemaVersion": 1, "clients": [{ "id": "client-a", "token": "...mínimo 32 bytes...", "enabled": true }] }`. IDs devem ser únicos e tokens não podem se repetir. Desative ou remova um cliente para revogar seu token.
- O formato legado de token único em texto continua aceito, identificado como `legacy`. Para rotação com sobreposição, migre para o formato JSON.
- Logs de auditoria registram eventos, horário, ID do cliente e endereço remoto quando necessário; nunca registram tokens ou cabeçalhos de autorização.
- Faça a substituição do arquivo de credenciais por escrita em arquivo temporário e rename atômico, com permissões restritas. Credenciais são lidas em cada requisição; arquivo inválido ou inacessível falha fechado com HTTP 503.
- O limitador ainda é por processo; use gateway com limites compartilhados em ambiente distribuído.

## v0.33.1 — Rate limits and multi-process safety tests

The remote witness service now applies a bounded per-process request rate limit (`ZION_WITNESS_RATE_LIMIT_PER_MINUTE`, default `60`) after bearer authentication, rejects non-JSON challenge requests with HTTP `415`, and has a regression test for two service processes sharing one state file. Rate limiting is local to each process; deployments with multiple instances must enforce a shared limit at a trusted gateway. A stale lock intentionally causes requests to fail closed until an operator verifies that no process owns it and removes it safely.

## v0.33.0 — Authenticated remote witness client

- The remote witness challenge endpoint now requires a bearer token loaded from `ZION_WITNESS_CLIENT_TOKEN_FILE`; tokens must contain at least 32 bytes and are compared using constant-time comparison after length validation.
- Requests without valid credentials are rejected with HTTP 401 before challenge processing or state mutation.
- Provision the token file out of band, restrict its filesystem permissions (for example `0600`), and do not commit it to source control. Rotate by coordinated service/client update.
- Bearer authentication does not encrypt transport. Keep the service bound to localhost or place it behind correctly configured TLS; never send the token over plaintext networks. Rate limiting, per-client identities/scopes, automated secret rotation, and rollback-resistant state remain future work.

## v0.32.99 — Durable remote witness state

- The remote witness persists consumed nonces in the same atomic state snapshot as its sequence, so a replay remains rejected after process restart. Expired nonce records are pruned; the service fails closed at 10,000 live nonce records instead of evicting valid replay defenses.
- Cross-process state mutation is guarded by an exclusive lock directory. Lock acquisition is bounded and a stale/uncertain lock is not automatically stolen; operators must inspect and safely clear a stale lock only after confirming no service process owns it.
- State replacement fsyncs the temporary file and containing directory. If persistence or durability confirmation fails, the service does not issue a signed success response.
- State schema v1 is read and migrated on the next successful update. This protects against ordinary process restarts and concurrent local service instances, but not malicious rollback of a disk/VM snapshot or storage controlled by an attacker. Use externally anchored monotonic state for that threat.
- Bind to localhost by default. Before network exposure, add authenticated TLS/reverse-proxy controls, client authentication, and deployment-specific abuse protection. No production deployment is implied.

## v0.32.98 — Remote witness service

- Added an opt-in Node.js HTTP witness service at `POST /v1/witness/challenge`. It validates short-lived challenge shape and expiry, signs responses with an Ed25519 key, and serializes sequence updates to a local state file.
- The service binds to `127.0.0.1` by default. Configure `ZION_WITNESS_HOST`, `ZION_WITNESS_PORT`, `ZION_WITNESS_ID`, `ZION_WITNESS_KEY_ID`, `ZION_WITNESS_PRIVATE_KEY`, and `ZION_WITNESS_STATE`.
- This is a protocol component, not a hardened public deployment. At this stage nonce replay memory reset on process restart, and local sequence state was not hardware-backed or protected against snapshot rollback.

## v0.32.65 — Corruption-safe state loading

- Corrupt JSON and invalid persisted records now produce explicit error codes; the original state file is never auto-overwritten.
- Canonical state is validated before abandoned temporary files are cleaned, preserving potential recovery evidence when the canonical snapshot is corrupt.
- Duplicate notification IDs and duplicate owner-scoped event keys are rejected at load time.

## v0.32.64 — Abandoned temporary snapshot recovery

When an operation next acquires the store's local file lock, it removes abandoned snapshot temp files matching the exact UUID naming scheme used by the store. It uses `lstat` and unlinks matching symlinks rather than following them, while preserving unrelated files and directories. This prevents accumulation of partial snapshots after process termination; it does not repair a corrupt canonical file or guarantee storage-device durability.

## v0.32.63 — Directory fsync contract

The notification store now surfaces directory-fsync failures after atomic replacement as `NOTIFICATION_STORE_DURABILITY_UNCONFIRMED`. Because rename has already made the new snapshot visible, memory remains aligned with the canonical file instead of pretending the commit rolled back. Callers must treat this error as a visible but durability-uncertain commit and use idempotency keys when retrying.

## v0.32.62 — Durable snapshot rollback

- Failed atomic state writes now roll in-memory mutations back to the last known persisted snapshot.
- Added a regression test that forces atomic replacement to fail and checks that no phantom state remains visible.
- This rollback applies to failures before the atomic rename commits; disk/device failures after a successful commit remain subject to filesystem guarantees.

## v0.32.61 — Real crash-window verification

Adds a child-process regression test that exits abruptly after the durable dispatch-intent write. A newly constructed store waits for the old lease to expire, then moves the notification to `ambiguous` instead of blindly retrying. This exercises actual process termination and persisted state, but is not a power-loss/filesystem durability certification.

## v0.32.58 — Graceful shutdown
- The delivery worker now aborts active adapter calls when stopped and waits only for local state handling, not the configured provider timeout.
- An interrupted delivery is persisted as `ambiguous`; interrupted reconciliation releases its claim without converting uncertainty into a retry.
- Adapters should honor the provided `AbortSignal`, use the stable idempotency key, and implement provider-side reconciliation where available.

## v0.32.57 — Crash recovery and restart verification

- Adds child-process crash/restart tests for persisted claims and lease expiry.
- Confirms ambiguous notifications survive store reconstruction and are reconciled before sending again.
- Delivery remains at-least-once unless the provider honors idempotency keys and offers reliable reconciliation. No production deployment is implied.

## v0.32.56 — Bounded provider operations
The delivery worker now supports `providerTimeoutMs` (default 30 seconds), which must be shorter than `deliveryLeaseMs`, and passes an `AbortSignal` to both `deliver` and `reconcile` adapters. A timed-out send becomes `ambiguous`; a timed-out reconciliation keeps the item ambiguous and releases its claim. Adapters should honor `signal` and implement provider idempotency/reconciliation. A timeout cannot prove that the remote provider stopped processing the request.

## v0.32.55 — Ambiguous delivery reconciliation
The outbox now supports an explicit `ambiguous` state for notifications whose provider outcome cannot be established. A provider adapter can return `{ outcome: 'unknown', reason: '...' }` or throw a marked/recognized network timeout error; the worker will not automatically resend that record. Configure the optional `reconcile` callback to return `{ outcome: 'delivered', receipt: '...' }`, `{ outcome: 'not-delivered' }`, or `{ outcome: 'unknown' }`. Without provider-specific reconciliation, ambiguous records remain held rather than risking blind duplicate sends. This is a protocol hook, not a built-in integration with any real provider.

## v0.32.54 — Validated delivery state and claim-bound attempts
The outbox now validates persisted timestamps, delivery receipts, claim/lease pairs, and record bounds when loading state. Attempt counters are updated only when the caller still owns the current delivery claim, preventing a stale worker from incrementing attempts after a lease has been replaced. The adapter's legacy direct-delivery path remains for compatibility and does not use claim fencing; production delivery should use the worker and a provider adapter with idempotency support.

## v0.32.53 — Delivery-claim failure recovery
The delivery worker now releases a notification claim if recording the attempt fails, avoiding an unnecessary lease-length delay after a local persistence error. This does not change the at-least-once delivery contract or replace provider-side idempotency.

## v0.32.51 — Cross-process notification outbox coordination

The notification outbox now serializes reads and mutations across independent Node.js processes sharing the same local state file, reloads the latest state under an exclusive lock, rejects symlink lock files, and uses a bounded lock wait. This targets single-host multi-process deployments on filesystems that provide exclusive file creation and atomic rename; it is **not** a distributed lock for multi-host/network-filesystem deployments.

## v0.32.50 — Inactivity notification runtime composition

`src/inactivity-notification-runtime.js` composes the durable outbox, policy `notify` callback, authenticated notification API, and delivery retry worker. Pass its `notify` callback to `InactivityResourcePolicy`, and pass `api` plus `deliveryWorker` to `OfficialNodeBootstrap` to make their lifecycle follow verified node startup and quarantine cleanup. See [`docs/INACTIVITY_NOTIFICATION_RUNTIME.md`](docs/INACTIVITY_NOTIFICATION_RUNTIME.md) for the integration contract. The factory does not provision credentials, identity authority, provider adapters, TLS ingress, or production storage; delivery remains at-least-once, and the file-backed outbox requires a shared local filesystem with reliable exclusive-create and atomic-rename semantics; it does not coordinate across hosts.

## Zion Cloud UI and experimental social messaging (v0.32.38)

A responsive Portuguese interface prototype is available in `cloud/`. Run `npm run cloud:preview` and open `http://127.0.0.1:4173`. It includes overview, file listing/search/filter, illustrative node status, activity, settings, a local-only file picker, and a social preview for following profiles and composing messages within the current browser session. The experimental `src/social-message-protocol.js` module adds a tested cryptographic envelope for private messages, documented in [`docs/SOCIAL_MESSAGING_PROTOCOL.md`](docs/SOCIAL_MESSAGING_PROTOCOL.md); it does not deliver messages over the network. The experimental `src/social-message-inbox.js` adds a durable bounded local queue for encrypted envelopes; it is a storage primitive, not a public relay or network delivery service. `src/social-identity-directory.js` adds a local persistent directory whose identity IDs are signing-key fingerprints and whose profiles require proof of key possession; the HTTP adapter can bind senders to registered signing keys and verify recipient-signed acknowledgements. Inbox reads fail closed unless a per-recipient authorization callback is configured. See [`docs/SOCIAL_MESSAGE_INBOX.md`](docs/SOCIAL_MESSAGE_INBOX.md). This is **not a connected cloud service**: file bytes are not uploaded or persisted, and node/usage metrics are demonstration data. See [`cloud/README.md`](cloud/README.md) before deployment.

## v0.32.20 — Runtime quarantine containment

`OfficialNodeBootstrap` now subscribes to the mandatory `IntegrityGuard` quarantine event. If integrity fails after startup, the bootstrap closes the official transport and stops storage, rather than relying only on a future request to notice quarantine. The listener is removed on explicit shutdown. This is best-effort process-level containment; adapters must implement reliable, idempotent close/stop semantics, and it is not an OS secure-boot boundary.

# Zion

## v0.32.18 — Official-mode maintenance integrity gate

`ReplicaMaintenanceService` now accepts `networkMode: 'official'`. In that mode, construction fails unless an `IntegrityGuard` exposes `checkHealthy()`, `assertHealthy()`, and a status object. Each repair rechecks the guard before reading the replica catalog, contacting recovery peers, or invoking replication. An already-quarantined or failed guard prevents all of those operations. The default `legacy` mode remains for compatibility and is not evidence of official-network conformance.

## v0.32.17 — Integrity-gated replica maintenance

- Replica maintenance now accepts the local `IntegrityGuard` and rechecks it before catalog reads, peer recovery, or replication.
- If local release integrity is not healthy, repair stops with `local-integrity-not-healthy` and performs no peer or catalog operations.
- This is a local trust boundary; it does not treat remote self-reported integrity metadata as cryptographic proof.

## v0.32.16 — Integrity-aware replica recovery

Replica recovery now excludes peers marked quarantined and peers whose explicitly supplied integrity status is not `verified` before issuing network requests. Older peer descriptors without an integrity field remain accepted for compatibility, so deployments should propagate the live `IntegrityGuard` status into peer descriptors. This is local candidate filtering, not proof that a remote peer is honest; recovered ciphertext is still checked against the requested SHA-256 content ID.

Zion is an experimental, open-source foundation for peer-to-peer storage designed around one rule: **the owner's computer comes first**.

This repository is a local engineering prototype (v0.32.38), not a production-ready public network. **Release blocker:** the current `LICENSE` file is only a notice, not the full AGPL-3.0 license text; do not treat this archive as a complete AGPL distribution until the official license text is added and the intended licensing is confirmed. It currently provides a conservative adaptive resource governor, authenticated encryption for local chunks, content addressing, and a replica-placement planner. A minimal signed TCP transport now exists for local testing. Peer discovery is only represented by an experimental, dependency-injected libp2p content-routing adapter; the actual libp2p node, Kademlia DHT service, bootstrap configuration, and internet connectivity are not wired or validated. Production key management is not implemented. An experimental Linux cgroup v2 adapter can apply CPU/memory/PID limits, but it is deliberately incomplete and cannot enable production contribution.


### Inactivity pause and capacity reduction (v0.32.37)

`InactivityResourcePolicy` implements staged inactivity handling with owner notifications before pausing contribution and before reducing offered capacity. Defaults: warn 7 days before pausing at 14 days; warn 7 days before reducing the offered capacity at 37 days (notice at day 30). Renewed activity can resume contribution and restore the previous capacity. Capacity reduction is blocked while existing replica bytes exceed the target unless a migration callback proves safe relocation and the usage check fits; this controller never deletes files or evicts replicas itself. State is persisted atomically. The UI describes the policy but remains a preview and is not connected to a live node. See [`docs/INACTIVITY_RESOURCE_POLICY.md`](docs/INACTIVITY_RESOURCE_POLICY.md).

### Individual social authentication (v0.32.36)

When a `SocialSessionAuthority` is configured alongside a `SocialIdentityDirectory`, the social HTTP node exposes `POST /api/v1/auth/challenge` and `POST /api/v1/auth/session`. A client signs the one-time challenge with its registered Ed25519 private key, then receives a short-lived bearer session. In this mode, the shared deployment token is not accepted for protected messaging routes; sending is bound to the authenticated sender identity, and inbox reads and acknowledgements are bound to that same session identity. See [`docs/SOCIAL_SESSION_AUTH.md`](docs/SOCIAL_SESSION_AUTH.md). Sessions are memory-only and are invalidated on process restart. The challenge endpoints are experimental and still need production-grade edge rate limiting, TLS, secure key custody, session persistence/revocation policy, and independent security review.

## Official protocol operation gate (v0.32.5)

`networkMode: 'official'` now applies a protocol-level schema gate to outgoing and incoming application messages after handshake and before the application handler. The gate checks known operation types, bounded identifiers and counters, canonical Base64 transfer segments, and basic store-request/receipt shapes. It does not replace domain authorization, request correlation, final chunk digest verification, durable-write checks, or local quota enforcement; those remain mandatory in the operation handlers. Legacy mode remains for compatibility and must not be used as a public-network security boundary. The official network genesis is still a reviewed configuration input, not a finalized public-network commitment.


## v0.32.11 — Immediate network isolation on quarantine

In official network mode, `PeerTransport` now subscribes to the `IntegrityGuard` quarantine event. When integrity fails, it immediately destroys established peer sockets and stops the TCP listener instead of waiting for another send/receive operation to discover the failure. `close()` unregisters the listener to avoid retaining transport instances. A regression test exercises a connected official-mode peer and verifies that quarantine closes the session and listener.

This is a local process-level containment measure, not a distributed consensus rule: other nodes cannot infer that a peer is compromised unless they receive authenticated protocol evidence or their own connection fails. The public-internet transport and real DHT remain unvalidated; do not treat this prototype as production-ready.

## v0.32.9 — Quarantine cleanup and critical-operation gating

The Integrity Guard now supports quarantine listeners so dependent services can stop in-flight work immediately when verification fails. `PeerStorageService` registers a listener, overwrites temporary transfer-part buffers where possible, clears incomplete transfer state, resets buffered-byte accounting, and rejects pending chunk downloads. Persisted encrypted chunks are intentionally preserved for incident response and controlled recovery. Outbound `sendStoreChunk()` and `fetchChunk()` now await integrity verification before touching the transport, and contribution-credit refresh re-checks integrity after the inventory audit before applying credit.

This remains defense-in-depth, not a secure-boot mechanism. JavaScript buffer overwriting is best-effort; copies may exist in runtime internals, strings, kernel buffers, or the transport. A process with administrator/root privileges can replace the verifier or its trust configuration unless an independent OS/hardware trust boundary protects them. Do not expose the current TCP transport to the public internet.

## Safety contract

- Local hard limits are configured by the owner and are never raised by remote peers.
- The governor can reduce work to zero when the host is busy, hot, on battery, under memory pressure, or when telemetry is unavailable.
- A JavaScript governor alone cannot guarantee hard OS-level limits. The experimental Linux adapter verifies CPU, memory, and PID limits only; disk I/O, network bandwidth, thermal monitoring, user-activity policy, and Windows/macOS adapters remain missing. Production participation requires a verified adapter marked complete, so this partial adapter cannot enable it.
- Storage is opt-in. This prototype never executes code supplied by other peers.
- Encrypted chunks use Node.js built-in AES-256-GCM and SHA-256. The local encrypted chunk store defaults to a 4 MiB maximum plaintext chunk and a 1 GiB storage quota; both are configurable by the local owner. The store tightens root-directory permissions where supported, rejects symlinks in the storage tree, and uses fsynced temporary files with atomic no-overwrite linking. Quota checks serialize writes within one process and coordinate separate store instances through an atomic directory lock with conservative stale-lock recovery. This is best-effort cross-process coordination, not a substitute for OS-enforced quotas or protection from a malicious process with the same account permissions. The caller must protect the 32-byte key; this prototype is not a complete key-management system.

## Requirements

Node.js 20 or newer. No cloud account, database server, blockchain, or external service is required for local tests.

## Run

```sh
npm test
npm run demo
```

## Current boundaries

The current implementation is still an engineering prototype, not a public decentralized cloud. The signed TCP transport can now connect two local processes and the experimental `PeerStorageService` supports segmented ciphertext upload/download with a local receipt. This is a protocol integration test, not internet-wide peer discovery or a production deployment. Replica planning is advisory and does not prove that remote copies remain available. `src/replication-receipts.js` adds bounded, expiring store requests and signed acknowledgements bound to the requested node, chunk digest, and byte count. `src/replication-coordinator.js` now orchestrates a bounded replication round: it chooses only eligible distinct failure domains, sends encrypted envelopes to selected peers, validates signed receipts, and reports under-replication rather than claiming success when too few copies confirm. These receipts are authenticated claims—not cryptographic proof of durable storage—and the storage handler is experimental and does not provide a proof of ongoing possession or availability. Hashes detect corruption only when the expected digest is trusted. Availability cannot be guaranteed if every copy is lost or unreachable.

See [architecture](docs/ARCHITECTURE.md), [resource safety](docs/RESOURCE_SAFETY.md), [threat model](docs/THREAT_MODEL.md), and [protocol immutability](docs/PROTOCOL_IMMUTABILITY.md).

## Experimental replication coordinator (v0.11.0)

`src/replication-coordinator.js` connects the placement planner, segmented peer storage protocol, and signed receipt tracker. The caller supplies already-connected peer sockets and current local resource/availability information. The coordinator reports confirmed receipts and missing replicas; it does not perform peer discovery, durable metadata persistence, background repair, or proof of continued possession. A signed receipt remains a remote claim. Keep the transport on loopback until authenticated connections are also encrypted and peer discovery/security are reviewed.

## Experimental peer storage

`src/peer-storage-service.js` provides `OpaqueReplicaStore` and `PeerStorageService`. It stores REAC1 encrypted envelopes without the storage node holding the user encryption key, splits transfers into bounded signed frames, checks the ciphertext digest, and sends a receipt only after the file is persisted. `GET_CHUNK` supports retrieval in the local protocol test. The replica store quota is enforced by the application and serialized across cooperating store instances/processes through an atomic directory lock. It is still not an OS-enforced filesystem quota and cannot stop a different process running with the same account permissions from modifying the directory or bypassing the API. The signed TCP transport does not encrypt the connection itself, so do not bind it to a public interface.

## Peer security foundation

`src/peer-security.js` adds Ed25519-signed messages, public-key-derived node IDs, timestamp validation, a bounded replay guard with heap-based expiry, and a bounded per-peer token bucket that fails closed when its peer table is full. `src/signed-manifest.js` signs canonical manifests of encrypted chunks and verifies owner identity, chunk IDs, duplicate entries, total size, and signatures. See [Bitcoin-inspired security principles](docs/BITCOIN_SECURITY_PRINCIPLES.md). The primitives are wired into a bounded newline-framed TCP transport in `src/peer-transport.js`, which defaults to loopback, supports outbound connections, checks signatures/freshness/replay/rate limits, and allowlists message types. The transport is authenticated but not encrypted end-to-end at the connection layer; do not expose it to untrusted public networks yet. This is an early transport layer—not a production-ready public network, encrypted transport, a running Kademlia DHT, or complete OS-enforced sandbox. `src/os-enforcement.js` provides partial Linux cgroup v2 CPU/memory/PID limits but explicitly refuses to claim complete enforcement. `src/adaptive-controller.js` adds immediate safety stops, stable-sample resumption, a configurable cooldown, and an explicit owner pause; it is policy logic, not a substitute for OS-level enforcement.

## Durable local replica catalog (v0.12.0)

`src/replica-catalog.js` persists replication metadata atomically, validates the catalog schema on load, limits entries, serializes updates within a process, and uses an exclusive lock file to prevent concurrent writers across processes. If the lock remains after a crash, updates fail closed; an operator must inspect the recorded state and remove the stale lock manually. The catalog stores historical signed-receipt metadata only: it does not independently prove that a remote replica is still online or durable. `markNodeUnavailable()` removes that node's claims and makes affected chunks visible as under-replicated. This is a local metadata foundation, not yet a background repair daemon or peer-discovery service.


## Experimental replica recovery (v0.13.0)

`src/replica-recovery-service.js` attempts to fetch a content-addressed encrypted envelope from known, already-connected peers in order. The storage service correlates each bounded transfer to a random request ID, checks every segment and the final SHA-256 digest, and can persist the recovered envelope locally through the quota-limited opaque store. If a peer fails or has no copy, the recovery service tries the next peer and returns an explicit failure if no verified copy is available. This is still a connected-peer recovery primitive: it does not discover peers, prove remote availability in advance, repair catalog metadata automatically, encrypt the TCP connection, or provide production-grade OS-enforced quotas. Keep the transport on loopback.

## Experimental replica maintenance (v0.14.0)

`src/replica-maintenance-service.js` joins the durable catalog, verified chunk recovery, and replication coordinator. For catalog entries already marked under-replicated (for example, after `markNodeUnavailable()`), it tries to obtain a content-addressed ciphertext from the local store or a previously recorded replica, verifies the digest and byte count, then asks the coordinator to place missing copies on distinct eligible peers and persists the merged receipt set. It fails closed when no verified source is available. This is an explicitly invoked repair primitive, not a background daemon; historical receipts can still be stale unless the operator or a future health-check mechanism marks unavailable nodes.


## Owner-set storage capacity and explicit exhaustion (v0.15.0)

`OpaqueReplicaStore` now coordinates quota checks and writes across independent instances that share the same storage root. It fails closed when the lock cannot be acquired safely and raises the machine-readable `REA_CAPACITY_EXHAUSTED` code when the owner-set application quota is full. `PeerStorageService` converts that condition into a signed `STORE_REJECTED` message with `CAPACITY_EXHAUSTED`, and `ReplicationCoordinator` records the failure and tries another eligible failure domain when one is available. This makes capacity exhaustion explicit and enables rerouting; it does not make the quota a kernel-enforced physical boundary. The configured byte limit covers stored replica payload files, not all filesystem metadata, temporary files during atomic writes, logs, or other programs' disk usage. A true hard disk ceiling requires a dedicated OS-enforced quota/volume in addition to this application policy. Sparse files alone are not proof of physical reservation on every filesystem.

## Rust storage core foundation (v0.16.0)

`rust-core/` now contains an experimental Rust crate for storing opaque REAC1 encrypted envelopes. It validates SHA-256 content addressing, rejects invalid envelopes, checks owner-configured per-block and payload quotas, uses atomic no-overwrite writes, and exposes explicit capacity exhaustion. Unit tests cover storage/readback, quota overflow, and invalid content. The current Node.js runtime remains active: this crate is **not yet connected** to `OpaqueReplicaStore`, and Rust tests could not be run in environments without Rust/Cargo. See [rust-core/README.md](rust-core/README.md) for the API boundary and limitations. This is a staged migration, not a claim of completed native integration or hard OS-level disk isolation.


## Optional Rust sidecar boundary (v0.17.0)

`rust-core/` now defines an opt-in `rea-storage-cli` binary with `init`, `put`, `get`, and `usage` operations, plus `src/rust-storage-adapter.js` for invoking a separately built binary with explicit owner-controlled limits. The adapter bounds execution time and output size, validates chunk IDs, independently verifies returned envelopes, and maps capacity exhaustion to a typed error. It deliberately does not silently fall back to JavaScript.

This is an **integration boundary**, not yet a completed migration: the sidecar is not wired into `OpaqueReplicaStore`, and the Rust code has not been compiled or executed in this environment because Cargo is unavailable. The adapter's Node.js tests use a fake child process and validate request/response handling only. Before enabling it, run `cargo test --manifest-path rust-core/Cargo.toml`, build the CLI, and perform cross-platform storage and crash/concurrency tests.


## Fair use and anti-abuse

See [`docs/FAIR_USE_AND_ANTI_ABUSE.md`](docs/FAIR_USE_AND_ANTI_ABUSE.md) for the contribution-based personal quota, in-memory and persistent per-peer admission guards, setup instructions, and the remaining Sybil/global-accounting limitations.


### Anti-abuse hardening (v0.20.0)

Daily quotas use a monotonic accounting-day rule: a backward system-clock adjustment does not reset counters or delete newer accounting history. Counters roll over only when the observed UTC day advances beyond the stored day. If the wall clock is corrected backward, participants may temporarily wait until the accounting day catches up; this is intentionally conservative and prevents clock rollback from granting extra daily capacity. This does not solve Sybil identities or replace OS-enforced resource quotas.

### Verified contribution accounting and expiring credit (v0.22.0)

`PeerStorageService.refreshVerifiedContribution(policy)` computes contribution credit from an integrity audit of the local replica store. It re-reads stored ciphertext, verifies each content-addressed chunk, rejects unexpected filesystem entries, and updates the fair-share policy only after the complete audit succeeds. Failed audits now revoke previous credit rather than retaining stale allowance. `FairSharePolicy` expires evidence after 15 minutes by default (configurable with `contributionTtlMs`); a clock rollback also fails closed. The application must schedule fresh audits more frequently than the TTL if it wants to keep earning personal quota. This is a point-in-time local integrity check—not proof that a replica will remain available, a defense against a malicious local administrator, persistent credit ledger, or an OS-enforced disk quota. See [fair use and anti-abuse](docs/FAIR_USE_AND_ANTI_ABUSE.md).

### Scheduled contribution audits (v0.25.0)

`src/contribution-audit-scheduler.js` adds an opt-in, bounded periodic audit runner. It coalesces overlapping runs, limits the number of inventory entries per audit, requires the interval to be shorter than the configured contribution-evidence TTL, and revokes credit when an audit fails. Construct and start it locally after storage and policy initialization; it is not started implicitly by the library. This prevents stale evidence from being kept alive by a missing refresh loop, but it is still a point-in-time local integrity check—not a remote proof of availability or OS-enforced quota.


**Resource-aware gating (v0.24.0):** the scheduler can receive both `adaptiveController` and an asynchronous `getTelemetry` callback. When configured, it skips the disk audit unless the adaptive controller grants a positive work budget. Missing telemetry, callback errors, owner pause, or unsafe host conditions fail closed without revoking still-fresh evidence; the evidence naturally expires under the policy TTL if no later audit succeeds. This is a start gate, not preemption or a hard OS-level I/O/CPU limit. Both options must be supplied together.


**Cooperative audit batches (v0.25.0):** inventory verification yields to the event loop after a configurable batch (default 128 chunks, maximum 4096) and rechecks the resource gate before continuing. If local resources become unavailable, the audit pauses without granting new credit or revoking still-fresh evidence; that evidence remains subject to its normal TTL. Integrity failures still revoke credit. This reduces long uninterrupted scans but does not provide a durable cross-restart checkpoint or an OS-level resource guarantee.

### Durable owner pause (v0.27.0)

An application that owns the local configuration can make an explicit contribution pause survive process restarts by passing `pauseStatePath` to `AdaptiveResourceController`:

```js
const controller = new AdaptiveResourceController({
  governor: new ResourceGovernor(),
  pauseStatePath: '/var/lib/zion/owner-pause.json',
});
```

`pause(reason)` writes a versioned local state file through an atomic replacement with restrictive file permissions where supported. On startup, a valid persisted pause remains active even if telemetry is healthy. An unreadable or malformed state fails closed (contribution remains paused). Only a deliberate local `resume()` clears the persisted pause, and resource hysteresis still applies before work can restart. If persistence fails during `pause()`, the controller remains paused in memory and surfaces the error. Without `pauseStatePath`, pause remains process-local for compatibility; production hosts should configure a protected, durable local path and ensure its parent directory is not writable by untrusted users.

This is application-level state persistence, not protection against a privileged local attacker, disk failure, or a hostile administrator. OS-enforced resource limits remain a separate requirement.

### Durable inventory audit checkpoints (v0.28.0)

`OpaqueReplicaStore.auditInventory()` and `PeerStorageService.refreshVerifiedContribution()` accept an optional `checkpointPath`; `ContributionAuditScheduler` forwards the same option. After each completed batch, a versioned checkpoint stores the sorted inventory IDs and scan cursor via a private temporary file and atomic rename. If a run pauses or the process stops, a later run can recognize the saved cursor. For safety, it re-enumerates the current inventory and re-hashes every chunk—including the previously scanned prefix—before granting any contribution credit. If the inventory membership changed, the audit fails closed rather than trusting stale progress. A completed audit removes the checkpoint. Keep the checkpoint outside the replica root, in a protected local directory; malformed, oversized, or symlink checkpoints are rejected. This is durable progress metadata, not a trusted credit ledger or a defense against a malicious privileged local administrator.

```js
const scheduler = new ContributionAuditScheduler({
  storageService,
  fairSharePolicy,
  intervalMs: 5 * 60 * 1000,
  batchSize: 128,
  checkpointPath: '/var/lib/zion/inventory-audit.json',
});
scheduler.start();
```


### Replication catalog commit boundary (v0.29.0)

`ReplicationCoordinator` accepts an optional `catalog` implementing `recordReplication()`. When configured, each completed replication round persists its confirmed signed-receipt metadata and the desired replica count before returning a normal result with `catalogPersisted: true`. If catalog persistence fails, the call throws `REA_CATALOG_PERSIST_FAILED` and attaches the remote round as `error.replicationResult`; remote writes may already have happened, so callers should reconcile/retry rather than assume rollback. Fair-share reservations are committed when at least one remote receipt was confirmed, even if the local catalog write fails, avoiding accidental quota release after real remote storage. The catalog records historical receipt claims only; it is not proof of ongoing remote availability. The catalog option is optional for compatibility.

```js
const catalog = new ReplicaCatalog('/var/lib/zion/catalog');
await catalog.init();
const coordinator = new ReplicationCoordinator({
  identity, transport, storageService, catalog,
});
```

This boundary narrows the gap between successful remote writes and local metadata, but it is not a distributed transaction: a process can still crash after remote persistence and before local catalog commit. Reconciliation and remote health checks remain necessary.


### Replica availability reconciliation (v0.31.0)

`ReplicaReconciliationService` checks currently connected peers that already have historical signed receipts for a catalogued chunk. A peer counts as currently verified only when a bounded fetch returns the exact expected byte count and SHA-256 content address. The catalog stores these observations separately from signed receipts, so a failed check does not erase historical evidence, and a disconnected peer remains unverified rather than being incorrectly declared dead. `availability.status` distinguishes `unverified`, `partially-verified`, `verified-available`, and `under-replicated`. This is an operator-triggered bounded pass, not a continuous health monitor or peer-discovery system.

```js
const reconciler = new ReplicaReconciliationService({ catalog, transport, storageService });
const report = await reconciler.reconcile({ peers: connectedPeers, limit: 500 });
```

The report reflects checks performed during that run; it is not a guarantee that a peer remains available afterward. The service does not discover peers or mark disconnected nodes unavailable.


## Zion project identity (v0.31.0)

The product and package are named **Zion**. Existing `REA` protocol identifiers, filenames, and wire-format labels are retained where changing them could break compatibility; they are implementation/protocol names, not the public product name. This source tree is prepared locally for transfer to the owner's GitHub repository. No remote repository was modified by this packaging step.

**Transport backpressure (v0.31.0 audit):** inbound frames are now dispatched sequentially per socket, with a maximum queue of 64 frames per connection. Overflow closes that connection instead of allowing unbounded concurrent async handler work. This is defense-in-depth for local testing, not a claim of public-network readiness or DDoS resistance.


### Experimental peer transport trust boundary

The TCP listener defaults to loopback. Binding to a non-loopback interface requires an explicit `trustedPeerIds` allowlist containing the expected SHA-256 node IDs. Exchange these IDs through a trusted out-of-band channel. This allowlist is not peer discovery, TLS, or network-wide Sybil resistance; do not expose the experimental transport directly to the public internet.


## Experimental DHT provider-discovery boundary

`src/dht-provider-discovery.js` defines a bounded provider-discovery policy and a thin adapter for a libp2p `contentRouting` implementation. It only announces chunks that the caller confirms are locally available, caps provider results, rejects malformed chunk IDs, and treats DHT results as untrusted hints. Callers must still authenticate the peer, verify the downloaded ciphertext digest, and check current availability. CID creation is injected so the application must choose and test the correct CID codec and mapping. **This does not yet mean Zion runs libp2p or Kademlia:** the package dependencies, libp2p node configuration, bootstrap peers, NAT traversal, periodic re-announcement, and end-to-end internet tests are not included. Network integration remains blocked until dependencies can be installed and the real service can be tested.


## Additional protocol building blocks (experimental)

- `src/node-proof-of-work.js`: cancellable SHA-256 admission puzzle bound to the public-key identity; difficulty is hardware-dependent and does not eliminate Sybil attacks.
- `src/gossip-relay.js`: bounded, expiring, deduplicated gossip-event relay; callers must authenticate origins and verify data.
- `src/adaptive-bandwidth-policy.js`: computes upload/download budgets (10% active-user upload default); it does not enforce OS traffic shaping by itself.
- Design constraints and production gates: [`docs/ADMISSION_GOSSIP_BANDWIDTH.md`](docs/ADMISSION_GOSSIP_BANDWIDTH.md).

### v0.32.0 outbound bandwidth enforcement

`PeerTransport` can now be configured with `AdaptiveTransferScheduler` to queue outbound signed frames under the adaptive upload budget. The queue is bounded and fails closed if telemetry is unavailable. This is application-level enforcement for scheduled frames only; it is not OS-wide network shaping.


## Protocol genesis handshake (v0.32.3)

`PeerTransport` can enforce a validated protocol genesis at connection time by
passing `protocolGenesis` to its constructor. In this mode both peers exchange
signed handshake messages containing the deterministic `NetworkID`, protocol
major version, and fresh 256-bit nonces. Each side must receive a signed ACK that
echoes its own nonce and binds the remote nonce before application messages can
be sent or delivered. Different network IDs, major versions, invalid signatures,
replayed envelopes, and rate-limited handshake traffic fail closed.

This is a transport-level compatibility gate, not a complete consensus system
or a proof that a remote executable follows every protocol rule. Applications
must still validate each operation before mutating state. The official genesis
parameters remain unfinalized; tests use fixtures only.

## Official protocol mode (v0.32.4)

For a deployment intended to join the official Zion network, construct `PeerTransport` with both `networkMode: 'official'` and the reviewed, pinned `protocolGenesis` document. Official mode refuses to start without genesis. Genesis-derived frame/message limits are enforced on both inbound and outbound application messages, and the genesis handshake is required before application traffic. The `legacy` default exists only for compatibility and tests; it is not evidence of conformance to the official network. Do not publish a genesis document as official until its parameters and hash have been independently reviewed and pinned in a release.

### Protocol operation hardening (v0.32.6)

`validateStoreRequest()` now validates the complete storage-request field set, target/chunk/byte commitments, and a bounded validity window. `PeerStorageService` applies this validation at the storage boundary before reserving transfer memory; receipt creation and the receipt tracker also validate request timing and structure. This hardens request semantics but does not replace authentication at the transport boundary, signed-receipt verification, or external security review.


## v0.32.7 — verified storage acknowledgement

The peer storage service now requires a storage adapter to return the expected content id and byte count, then reads the object back and verifies byte-for-byte equality and SHA-256 before committing resource admission or issuing a signed `STORE_RECEIPT`. If verification fails, the service releases the admission reservation and does not issue a success receipt. This improves acknowledgement integrity but is not a proof of long-term availability or protection against later disk failure.

## v0.32.8 — Integrity Guard

`src/integrity-guard.js` verifies a release manifest signed with Ed25519 using a trusted public key supplied independently at deployment. It checks manifest signature, expected release version, safe relative paths, regular files (no symlinks), and SHA-256 for each listed critical artifact. A mismatch permanently quarantines that guard instance; `assertHealthy()` fails closed. `PeerStorageService` accepts an `integrityGuard` and checks it before handling operations, writing replicas, generating receipts, and refreshing contribution credit.

Release signing is intentionally an offline release step. Keep the Ed25519 private key out of the repository and preferably on an offline machine. Generate a manifest with `ZION_RELEASE_SIGNING_KEY=/secure/offline/key.pem npm run manifest:sign -- 0.32.8 src/integrity-guard.js src/peer-storage-service.js package.json` (include every critical runtime artifact for the actual release). Provision and pin the corresponding public key independently of the release directory. The manifest is not self-authenticating if an attacker can replace both the files and the trusted public key.

Important limitations: this guard is defense-in-depth, not secure boot. An attacker with root/administrator privileges can patch the running process or its verifier unless the host provides an independent trust boundary (e.g. verified boot, locked-down service account, read-only release directory, external monitoring, and hardware-backed key protection). The guard deliberately quarantines and preserves data; it does not self-delete files or keys. The operator must pin `expectedReleaseVersion` and a non-empty `requiredPaths` list, call `verify()` before enabling network/storage services, and pass the verified instance into every critical service. `PeerStorageService` re-hashes the manifest-listed files at the configured verification interval (default 5 seconds) before critical operations; detection latency is therefore bounded by the interval plus the operation timing. This release does not yet enforce that wiring automatically across every process or deployment entrypoint.
## v0.32.14 — Immutable historical replication receipts

- Marking a replica node unavailable now records a fresh availability observation instead of deleting historical receipts.
- Historical storage acknowledgements survive catalog restart; current availability remains a separate, explicitly checked signal.
- Regression coverage checks that one unavailable node updates every affected chunk while preserving its receipt history.
- Validation is local; this release has not been deployed to a public multi-machine network.



## v0.32.15 — Quarantine-aware replica placement

- Replica placement excludes peers explicitly marked quarantined, even if they advertise online status, storage capacity, and an enabled resource budget.
- When a peer supplies an `integrityStatus`, only `verified` peers are eligible; omitted status remains compatible with legacy peer descriptors, so production deployments should populate the field from the local integrity guard.
- Scheduler and coordinator regression tests ensure quarantined peers are never selected or contacted and report under-replication honestly when no safe target remains.
- Validation is local; this release has not been deployed to a public multi-machine network.


### v0.32.21 — Retryable quarantine containment

Official-node containment now exposes a distinct status, preserves evidence when storage shutdown fails, and allows a supervisor to retry shutdown while the integrity guard remains quarantined. This is process-level containment, not an operating-system security boundary.


### v0.32.22 — Startup/quarantine race closure

The official bootstrap re-checks integrity after the asynchronous listener bind returns, so quarantine occurring during `listen()` cannot leave `started=true`. Startup rollback now reports incomplete cleanup separately and preserves storage-running evidence when shutdown fails. Regression tests cover quarantine during listener binding and storage startup. Local test results are not production or public-network certification.


### v0.32.23 — Lifecycle cancellation and shutdown serialization

The official bootstrap now invalidates in-flight startup when explicit shutdown or integrity quarantine begins. `close()` drains a pending startup before final shutdown, preventing a delayed asynchronous listener bind from resurrecting the node. Regression coverage includes an explicit close racing with a pending bind. This is lifecycle hardening, not production certification.


## Lifecycle cleanup serialization (v0.32.24)

The official-node bootstrap serializes transport/storage cleanup across startup rollback, quarantine containment, retry, and explicit close. This prevents concurrent shutdown adapter calls from racing each other. Adapter failures remain visible and do not count as successful shutdown. This is process-level coordination; adapters and operating-system supervision must still enforce their own shutdown contracts.


### v0.32.25 — Terminal lifecycle shutdown

An `OfficialNodeBootstrap` instance is now terminal after `close()` is requested. Further `start()` calls reject with `ZION_BOOTSTRAP_CLOSED`; create a new bootstrap instance to restart. The terminal latch is set synchronously, including when close must drain a pending startup. This prevents restarting an instance after its quarantine listener has been detached.


### Verifiable bootstrap containment (v0.32.26)

`OfficialNodeBootstrap.containmentReport` separates lifecycle intent from observed resource state. An official transport may implement `getStatus()` returning `{ listening: boolean }`; the storage integration may pass `getStorageStatus()` returning `{ running: boolean }`. A successful `close()`/`stopStorage()` call is not itself proof that a socket or storage worker stopped. Without these observations, the corresponding report state remains `unknown` and its evidence is `unverified`. Deployments should implement these methods using authoritative adapter or operating-system state where available.


### Auditable containment events (v0.32.27)

`OfficialNodeBootstrap` retains a bounded in-memory `containmentHistory` and accepts an optional `recordContainmentEvent(record)` callback. Events use schema `zion.containment-event.v1`, bounded details, and an in-process sequence. The optional callback can connect the events to a deployment-owned persistent audit store. Callback errors are surfaced in `containmentReport.audit.errors` and do not prevent urgent transport/storage cleanup. A known active resource remains reported as `running` even when cleanup fails; the bootstrap does not downgrade contradictory evidence to `unknown`.

The in-memory history is not durable. This version does not implement journal loading, crash-recovery reconciliation, tamper-proof audit storage, or restart authorization from persisted state. Those require an explicitly configured and tested persistence adapter and remain follow-up work. A successful callback alone does not prove the external store is durable or tamper-resistant.

### Social messaging transport adapter (v0.32.33)

The experimental `SocialMessageNode` module (`src/social-message-node.js`) connects signed encrypted envelopes to the durable inbox through a bounded HTTP API. It defaults to loopback, requires a bearer secret and explicit identity-backed sender/recipient authorization callbacks, and verifies envelope signatures before queueing. See `docs/SOCIAL_MESSAGE_NODE.md`. It is not yet a native P2P/libp2p delivery system and must not be exposed publicly without TLS and production identity/abuse controls.

### Inactivity policy scheduling

`src/inactivity-storage-adapter.js` now adapts `OpaqueReplicaStore` capacity and verified inventory to the policy callback contract. Quota updates are guarded by the storage lock and fail if occupied bytes do not fit. The quota value is stored in a bounded, atomically updated configuration file inside the protected storage root and is reloaded under the inter-process storage lock before writes; changes therefore survive restart and coordinate among instances sharing that root. The adapter intentionally does not implement replica eviction.

The inactivity policy can be driven by `src/inactivity-policy-scheduler.js`. See [`docs/INACTIVITY_POLICY_SCHEDULER.md`](docs/INACTIVITY_POLICY_SCHEDULER.md) for startup/shutdown wiring, verified activity requirements, and storage migration safety constraints. The scheduler is an integration primitive; production storage and notification adapters must be supplied by the host application.

### Inactivity policy lifecycle

`OfficialNodeBootstrap` can manage an optional `InactivityPolicyScheduler`: it starts the scheduler only after the node has passed integrity checks and storage/transport startup, and stops it before cleanup during shutdown or quarantine. This is an opt-in lifecycle hook, not an out-of-the-box production deployment. The host still needs to provide trusted activity signals and real notification, contribution-control, and replica-migration adapters. See `docs/INACTIVITY_POLICY_SCHEDULER.md`.

### Cloud inactivity settings preview (0.32.41)

The Cloud settings screen lets a user adjust the inactivity warning day, contribution-pause day, capacity-reduction warning day, reduction day, and percentage reduction. Values are validated and saved only in the current browser's local storage; the preview shows the configured timeline and preserves a visible notice that no remote node is configured. These preferences are **not** automatically passed to `InactivityResourcePolicy`, do not create real notifications, and do not change a live storage quota. A production integration must authenticate the owner, validate settings again server-side, persist them in protected node configuration, and confirm each applied transition.

### Authenticated inactivity preferences

The optional `InactivitySettingsService` (`src/inactivity-settings-service.js`) persists inactivity preferences per authenticated identity. See [`docs/INACTIVITY_SETTINGS_SERVICE.md`](docs/INACTIVITY_SETTINGS_SERVICE.md) for its adapter contract. It is a transport-neutral service, not a deployed HTTP API, and its results explicitly indicate `appliedToNode: false` until a runtime integration applies them.

### Inactivity settings API (v0.32.43)

The optional `InactivitySettingsHttpApi` exposes authenticated per-account inactivity preferences over HTTP. It binds to loopback by default, accepts bearer session tokens, limits JSON request bodies to 8 KiB, rate-limits by client address, and sends no-store/security headers. See [`docs/INACTIVITY_SETTINGS_HTTP_API.md`](docs/INACTIVITY_SETTINGS_HTTP_API.md). Remote binding must only be enabled behind trusted TLS ingress. This API saves preferences but does not itself apply them to a running node.


### Live inactivity settings (v0.32.45)

`src/inactivity-policy-settings-bridge.js` explicitly applies saved account settings to a running inactivity policy after validating the authenticated owner identity. Call it after owner authentication and before starting the policy scheduler. A successful response confirms only that the in-memory policy accepted the configuration; it does not imply that the node is deployed or that remote notifications are configured. See `docs/INACTIVITY_POLICY_SETTINGS_BRIDGE.md`.


### Inactivity notification outbox (v0.32.46)

Zion now includes a durable, owner-scoped notification outbox for inactivity policy events. Delivery is only marked confirmed when a configured provider returns a non-empty receipt. Without a provider, alerts remain queued and pending. See `docs/INACTIVITY_NOTIFICATION_OUTBOX.md`. This does not itself deliver push notifications or email, and shared-file multi-process operation requires additional coordination.

## Authenticated inactivity notification history (0.32.47)

See [`docs/INACTIVITY_NOTIFICATIONS_HTTP_API.md`](docs/INACTIVITY_NOTIFICATIONS_HTTP_API.md) for API and host wiring.

### Cloud notification center (v0.32.48)

The Cloud preview includes an authenticated notification history page. To enable live data, the host must provide `window.ZionAuth.getAccessToken`, load `inactivity-notifications-api-client.js`, and route the configured `zion-api-base` to an `InactivityNotificationsHttpApi` instance backed by the same durable notification store and session authority. Without that integration, the page explicitly remains unavailable rather than inventing notification records. The UI can list owner-scoped events and mark them viewed; it cannot forge delivery receipts or trigger provider delivery.


### Inactivity notification delivery retries (v0.32.49)

`src/inactivity-notification-delivery-worker.js` adds an opt-in retry worker for pending outbox records. Pass it to `OfficialNodeBootstrap` as `notificationDeliveryWorker` to have it start only after the official node passes integrity checks and storage/transport startup, and stop before shutdown cleanup. The host must provide a trusted `listOwnerIdentityIds` function and a real provider `deliver` adapter that returns a verifiable receipt. Retries use bounded batches, exponential backoff, and a 12-attempt default ceiling. Exhausted records remain pending for operator intervention. See [`docs/INACTIVITY_NOTIFICATION_DELIVERY_WORKER.md`](docs/INACTIVITY_NOTIFICATION_DELIVERY_WORKER.md). This is not a configured push/email service or a production deployment.

### Safe inline notification adapter (v0.32.60)

The policy adapter's optional direct-delivery path now follows the same durable claim and dispatch-intent protocol as the background worker. Exceptions after dispatch begins and failures to persist a provider receipt are treated as ambiguous outcomes; the adapter does not silently return the notification to a freely retryable state. Prefer the background delivery worker when provider reconciliation is available.

### Notification delivery crash-window safety (v0.32.59)

The notification worker durably records dispatch intent before invoking a provider. If a process dies after that point and the claim lease expires, the next claimant changes the notification to `ambiguous` instead of blindly resending it. Provider exceptions and failures to persist a returned receipt are treated as uncertain outcomes and should be resolved through the configured provider reconciliation adapter. This narrows the duplicate-delivery window but does not create exactly-once delivery: providers should honor the stable idempotency key, and host integrations must implement reliable reconciliation. An adapter's explicit `{ delivered: false }` result is treated as a definitive non-delivery contract.


### Notification outbox recovery snapshots (v0.32.66)

Before replacing an existing, validated notification outbox, the store writes the prior state to `<statePath>.last-good` using a temporary file, file sync, atomic rename, and directory sync. This is a **manual recovery artifact**, not an automatic failover mechanism: if the canonical state is corrupt, Zion preserves both files and fails closed. Use `InactivityNotificationStore.inspectRecovery({ statePath })` first. If and only if the canonical file is invalid or missing and the backup validates, an operator can call `InactivityNotificationStore.recoverLastGood({ statePath, confirmRestore: true, expectedCanonicalSha256: report.canonical.sha256 ?? null, expectedLastGoodSha256: report.lastGood.sha256 })`. Stop application writers before recovery even though the helper coordinates local writers with a file lock. The helper rechecks both hashes under that lock, validates the backup, refuses to overwrite a valid canonical state, preserves corrupt bytes to a unique file, and atomically restores the snapshot. If files change after inspection, inspect again. A last-good snapshot may be stale and can omit recently delivered notifications; restoring it may therefore require provider reconciliation to avoid duplicates.


### Read-only recovery assessment (v0.32.67)

Use `InactivityNotificationStore.inspectRecovery({ statePath })` to inspect the canonical notification state and its `.last-good` snapshot before planning manual recovery. The method validates each regular file, reports SHA-256 digests and record counts, and compares IDs only when both snapshots validate. It never rewrites, deletes, or restores either file. A last-good snapshot can be stale and must not be restored without an explicit operational decision.

### Explicit notification-store recovery (v0.32.68)

After read-only inspection, `InactivityNotificationStore.recoverLastGood()` can restore a validated `.last-good` snapshot only with `confirmRestore: true` and the exact canonical/backup hashes returned by inspection (`null` for a missing canonical file). It rechecks hashes under the local file lock, refuses to overwrite a valid canonical state, preserves invalid canonical bytes in a uniquely named `.corrupt-*` file, and performs an atomic replacement. It returns a structured recovery summary but does not claim a tamper-proof audit log. Stop external writers during recovery. If directory sync fails after rename, `NOTIFICATION_RECOVERY_DURABILITY_UNCONFIRMED` means the restored file is visible but durability is uncertain; inspect the state before retrying. Restoring a stale outbox may require reconciliation with the notification provider. Local file locking does not coordinate independent hosts or guarantee correctness on arbitrary network filesystems.


### Durable recovery audit (v0.32.69)

Successful explicit notification-store recovery now writes a unique `*.recovery-audit-<timestamp>-<uuid>.json` record after verifying the restored canonical state. The audit contains the prior canonical and last-good SHA-256 values, restored digest, record count, preserved corrupt-copy path, confirmation status, and timestamp; it does not include notification bodies or notification IDs. The audit file and containing directory are synced before success is returned. If the restored state is visible but the audit record cannot be confirmed durable, the operation reports `NOTIFICATION_RECOVERY_AUDIT_UNCONFIRMED` with `commitVisible: true`; callers must inspect state and audit artifacts rather than blindly retrying. Audit files are local evidence, not tamper-proof or remotely replicated logs.

### Post-recovery notification reconciliation report (v0.32.70)

`buildNotificationRecoveryReconciliationReport({ beforeRecords, restoredRecords, providerEvidence })` creates a read-only, owner-scoped report after a snapshot recovery. It flags records missing from the restored snapshot, regressions from previously delivered to non-delivered states, ambiguous outcomes, and provider evidence for delivered or definitively not-delivered outcomes. Evidence for `delivered` must include a non-empty receipt. The report never retries delivery, never mutates input records, and excludes notification bodies. It is a pure reporting utility: it does not query providers or prove a receipt's authenticity. Keep provider adapters and record acquisition outside this module and reconcile unknown outcomes before any resend.

### Durable notification reconciliation casebook (v0.32.71)

`NotificationRecoveryCasebook` persists read-only reconciliation reports as unique local case files. It uses restrictive permissions, exclusive publication to avoid replacing an existing case ID, file/directory synchronization, and SHA-256 verification when reading reports. It refuses report payloads that claim to have retried deliveries or mutated source records. Example:

```js
import { NotificationRecoveryCasebook } from './src/notification-recovery-casebook.js';
const casebook = new NotificationRecoveryCasebook({ directory: '/var/lib/zion/recovery-cases' });
const saved = casebook.save(report); // report from buildNotificationRecoveryReconciliationReport()
const verified = casebook.read(saved.caseId);
```

The casebook is local integrity checking, not tamper-proof storage: privileged access can alter files and recompute their hashes. It does not contact providers, retry notifications, or establish multi-host consensus.


### Recovery decision workflow (v0.32.72)

`NotificationRecoveryApprovalWorkflow` records durable operator decisions against the exact SHA-256 of a saved reconciliation case. Decisions require an approver and rationale, are append-only by unique decision ID, and are revalidated against the current case when read. Supported actions are `keep_pending`, `investigate`, and `authorize_manual_retry`; the latter authorizes review only and does not execute a retry. The workflow is local to its configured filesystem and is not a distributed consensus or cryptographic signature service.

### Signed notification recovery decisions (v0.32.73)

`NotificationRecoverySignedDecisionStore` adds an Ed25519-signed decision ledger for notification recovery reviews. Configure trusted public keys by key ID and pass the matching PKCS#8 private key only to `signDecision`. Decisions bind to the exact `reportSha256` of a casebook record, have a bounded TTL (1 second to 24 hours), and are invalidated when the case digest changes or the signing key is revoked. Duplicate decision IDs are rejected. The store never executes notification delivery or retries.

Example:

```js
import { NotificationRecoverySignedDecisionStore } from './src/notification-recovery-signed-decisions.js';

const decisions = new NotificationRecoverySignedDecisionStore({
  casebook,
  directory: './state/signed-recovery-decisions',
  trustedPublicKeys: { 'operator-key-1': publicKeyPem },
  revokedKeyIds: []
});
const signed = decisions.signDecision({
  caseId,
  expectedReportSha256: caseRecord.reportSha256,
  action: 'investigate',
  approver: 'operator:alice',
  rationale: 'Provider evidence must be reviewed before any retry.',
  keyId: 'operator-key-1',
  privateKey: privateKeyPem
});
const verified = decisions.read(signed.decisionId);
```

The key registry and revocation list must be obtained from a trusted configuration channel. A signature proves possession of a key, not the real-world identity or authority of its holder. Keep private keys out of the repository and logs. This feature records signed decisions only; it does not authorize an automatic retry executor.

### v0.32.74 — Persistent recovery trust registry

The signed recovery-decision store can now use `NotificationRecoveryTrustRegistry` (`src/notification-recovery-trust-registry.js`) for durable trusted Ed25519 public keys and revocations. Register only keys whose identity has been verified out-of-band, and restrict write access to the registry file and its directory.

Example:

```js
import { NotificationRecoveryTrustRegistry } from './src/notification-recovery-trust-registry.js';
import { NotificationRecoverySignedDecisionStore } from './src/notification-recovery-signed-decisions.js';

const trustRegistry = new NotificationRecoveryTrustRegistry({ statePath: './private/recovery-trust.json' });
trustRegistry.trustKey({
  keyId: 'operator-key-2026-01',
  publicKey: trustedEd25519PublicKeyPem,
  permissions: ['sign_recovery_decision'],
  actor: 'security-admin:verified',
  reason: 'Approved recovery operator onboarding.'
});
const decisions = new NotificationRecoverySignedDecisionStore({ casebook, directory: './private/recovery-decisions', trustRegistry });
```

Revocation is persisted with `trustRegistry.revokeKey({ keyId, actor, reason })`. Revoked IDs cannot be reactivated; key rotation must use a new ID. The registry is local filesystem state, not a distributed consensus service. Its digest detects corruption but is not a cryptographic signature, and concurrent writers across processes are not coordinated by this module. This feature does not execute recovery actions or notification retries.


### v0.32.75 — Concurrent trust registry and tamper-evident audit chain

`NotificationRecoveryTrustRegistry` now serializes key registration and revocation using a local exclusive lock file. Mutations reload the latest state after acquiring the lock, preventing cooperating processes from overwriting each other's changes. A bounded wait fails with `NOTIFICATION_TRUST_REGISTRY_LOCK_TIMEOUT` rather than silently proceeding without a lock. Dead-owner locks may be reclaimed only when the recorded PID is demonstrably absent; malformed or ambiguous locks are left untouched and eventually time out.

New trust/revocation audit events contain `previousEventHash` and `eventHash`; registry loads verify the event chain in addition to the outer state digest. Legacy events without chain fields remain readable, while newly chained events are validated. The chain detects local edits to events when checked against the stored chain, but it is not a signature, a remote anchor, or protection against an administrator who can rewrite the entire file and recompute every hash. Lock guarantees depend on the local filesystem's exclusive-create and rename semantics and do not provide multi-host distributed consensus.


### Signed audit anchor checkpoints (v0.32.76)

`NotificationRecoveryAuditAnchor` creates Ed25519-signed checkpoints that bind the trust registry revision, its state digest, and the current audit-chain head. Verifiers can compare a new checkpoint against a previously trusted checkpoint to detect rollback, same-revision forks, or broken checkpoint ancestry.

**Trust boundary:** keep the trusted checkpoint and signing key outside the registry's writable storage, ideally in an independent service or append-only system. A checkpoint stored beside the registry is not an independent anchor, and a signature proves control of a key rather than a real-world identity. The module does not automatically publish checkpoints to a remote service.

### Independent recovery audit anchor (v0.32.77)

`src/notification-recovery-independent-anchor.js` defines an adapter boundary for publishing signed recovery checkpoints to a separately operated destination. The client verifies signatures before publication, checks read-back, rejects rollback/fork attempts, and reports destination outages explicitly. `MemoryNotificationAnchorAdapter` is for tests only and is **not** a durable or independent production anchor. A production adapter must provide authenticated access, durable conditional writes, concurrency control, and a separate administrative/storage trust domain. No production destination is configured by this release.

### Persistent external audit anchor (v0.32.79)

`src/notification-recovery-file-anchor-adapter.js` provides `PersistentFileNotificationAnchorAdapter` for durable checkpoint storage. Configure `anchorPath` to a directory that is independently administered from the registry host/storage. The adapter serializes writers with an exclusive lock, performs atomic replacement, syncs the file and directory, rejects symlink checkpoint files, and fails closed on lock timeout instead of stealing a possibly live lock. A leftover lock requires an operator to investigate and remove it safely. This file adapter is not, by itself, a remote service or a security boundary if an attacker controls both the registry and anchor storage.


**v0.32.79 hardening:** cross-process tests launch independent Node processes for same-checkpoint races and competing forks. The reader opens the checkpoint with `O_NOFOLLOW` where supported and validates the opened descriptor, reducing the symlink check/read race. Lock files are intentionally not auto-reclaimed: inspect a leftover lock and the owning process before removing it.

### Persistent file anchor crash recovery (v0.32.80)

The persistent file anchor deliberately does not reclaim stale lock files automatically. A publisher that crashes after acquiring the lock can leave `checkpoint.json.lock` behind; subsequent publishers fail closed with `NOTIFICATION_ANCHOR_LOCK_TIMEOUT`. An operator should first verify that no publisher is active and inspect the checkpoint and temporary files before removing a stale lock manually. The automated test suite covers a separate Node.js process that writes and fsyncs the lock and then exits abruptly. This is a local filesystem adapter, not a remote consensus or independent freshness service.

### Interrupted-write handling (v0.32.81)

Atomic replacement means only the checkpoint at the committed anchor path is considered current; orphaned `.tmp-*` files are ignored and preserved for forensic inspection. If the committed checkpoint file itself is malformed, reads and new publications fail closed rather than overwriting potentially recoverable evidence. Temporary-file and stale-lock cleanup is intentionally manual. This behavior does not prove protection against disk rollback, controller lies, filesystem corruption, or hardware that fails to honor durability guarantees.


### v0.32.82 — process-crash temporary recovery

A child-process regression test now creates and fsyncs a partial checkpoint temporary file and exits abruptly. The adapter ignores that uncommitted file, preserves it for inspection, and can publish a valid canonical checkpoint afterward. This demonstrates process-crash handling only; it is not a power-loss simulation or a filesystem/device durability certification.

### v0.32.83 — Durability uncertainty after atomic rename

If atomic rename succeeds but parent-directory `fsync` fails, the adapter reports `NOTIFICATION_ANCHOR_DURABILITY_UNCONFIRMED`: the new checkpoint may be visible, but persistence across a crash is not confirmed. Repeating the same publication now fsyncs the committed file and parent directory before returning idempotent success. A deterministic injected-I/O test covers this recovery path; it does not simulate physical power loss or prove hardware durability.


### v0.32.84 — Lock release failure semantics

A lock cleanup failure is surfaced as `NOTIFICATION_ANCHOR_LOCK_RELEASE_FAILED`. If the checkpoint operation also failed, an `AggregateError` preserves the original operation error in `cause` and the lock-release failure in `errors`, so cleanup does not hide the primary failure. A failed lock cleanup leaves the lock in place for explicit operator inspection; it is not removed automatically.


**v0.32.85 lock ownership verification:** anchor lock records contain a random token and the identity of the file descriptor used to acquire the lock. Before cleanup, the adapter checks that the path still refers to that same lock and token. If the lock was replaced, it leaves the replacement untouched and reports `NOTIFICATION_ANCHOR_LOCK_OWNERSHIP_LOST`. This is a defensive check, not an atomic conditional-unlink primitive; it cannot defend against a privileged actor who can manipulate the directory, and operators must never remove a lock while a publisher may still be active. If lock initialization itself fails after creation, the state may require manual inspection.

### v0.32.86 — Read-only anchor diagnostics

Run `npm run anchor:diagnose -- /path/to/checkpoint.json` to inspect the persistent file anchor without changing it. The JSON report describes whether a checkpoint is absent, structurally readable, or untrusted; whether a lock is present; and whether temporary artifacts remain. It deliberately does not classify a lock as stale from its PID or timestamp, remove files, or attempt repair. A visible checkpoint is reported with `historical_durability_unknown`: a read-only local inspection cannot prove that a previous directory `fsync` completed or that the file was not restored from an older backup. Treat `attention_required` as a prompt for operator review, not an automated recovery instruction.

### Read-only checkpoint chain verification (v0.32.87)

`src/notification-recovery-checkpoint-chain-verifier.js` exports `verifyNotificationRecoveryCheckpointChain()` for checking an explicitly supplied ordered checkpoint history. It verifies every signature, expected signer and freshness policy, then requires each checkpoint to link to the previous checkpoint and advance the registry revision. A caller may supply `trustedCheckpoint` to anchor the first observed checkpoint to prior trusted state. The verifier is read-only and reports the failing index; it does not repair or rewrite history. A latest-only checkpoint cannot establish omitted historical continuity or prevent rollback without an independently retained trusted checkpoint or external freshness witness.

### Verify a signed checkpoint history in read-only diagnostics

The local anchor diagnostic can optionally verify an ordered checkpoint history against an independently trusted Ed25519 public key. This operation is read-only and never repairs or deletes evidence:

```bash
npm run anchor:diagnose -- /path/to/checkpoint.json \
  --history /path/to/checkpoint-history.json \
  --public-key /path/to/anchor-public.pem \
  --signer-key-id anchor-key-2026 \
  --max-age-ms 86400000
```

The history file must contain a JSON array ordered from its trusted chain start. The last history checkpoint must match the visible checkpoint file. A missing history or public key is reported as `not_checked`; malformed input, invalid signatures, broken links, or a latest-checkpoint mismatch are reported as `attention_required`. The public key must be trusted independently of the files being checked. A history that omits earlier checkpoints cannot establish the authenticity of the omitted past, and this local diagnostic is not a remote freshness witness.

### Explicit trust policy for anchor diagnostics (v0.32.89)

For a stronger local configuration, provision a trust policy through a channel separate from the checkpoint history. The JSON document has `schemaVersion: 1`, `signerKeyId`, `publicKeyPem`, and `publicKeySha256` (SHA-256 of the public key's DER SubjectPublicKeyInfo). Its fingerprint detects accidental or inconsistent key substitution, but **does not authenticate the policy by itself**. Protect/pin the policy independently.

```bash
npm run anchor:diagnose -- /path/checkpoint.json \\
  --history /path/history.json \\
  --trust-policy /path/anchor-trust-policy.json \\
  --max-age-ms 86400000
```

Use either `--trust-policy` or the lower-level `--public-key` input, not both. This release validates one externally provisioned key; it does not implement signed key rotation or provide an independent remote freshness witness.

### Signed anchor-key rotation (v0.32.90)

The rotation API validates a sequence of Ed25519 key transitions against an independently provisioned initial trust policy. Each transition must be signed by the currently trusted key and bind the next key ID, public-key PEM, SHA-256 fingerprint, timestamp, and previous transition hash. Example:

```js
import {
  createNotificationRecoveryAnchorKeyTransition,
  verifyNotificationRecoveryAnchorKeyRotation,
} from './src/notification-recovery-anchor-key-rotation.js';

const transition = createNotificationRecoveryAnchorKeyTransition({
  previousSignerKeyId: 'anchor-key-2026',
  signerKeyId: 'anchor-key-2027',
  publicKey: nextPublicKey,
  previousPrivateKey: currentPrivateKey,
  issuedAt: Date.now(),
});
const result = verifyNotificationRecoveryAnchorKeyRotation({
  trustPolicy: provisionedTrustPolicy,
  transitions: [transition],
  now: Date.now(),
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
});
if (!result.valid) throw new Error(`Untrusted rotation: ${result.code}`);
// result.activePublicKey and result.activeSignerKeyId identify the resulting trust anchor.
```

Keep the initial trust policy outside the storage domain being audited. This API verifies continuity and authorization of rotation; it does not provide remote freshness witnesses, an independent revocation feed, or protection if the initial trust policy itself is replaced by an attacker.


### Verify signed anchor-key rotation during diagnostics (v0.32.91)

```bash
npm run anchor:diagnose -- /path/checkpoint.json \
  --history /path/checkpoint-history.json \
  --trust-policy /path/externally-provisioned-trust-policy.json \
  --rotation-history /path/signed-key-rotations.json \
  --max-age-ms 86400000
```

Rotation history is verified from the externally trusted initial key; only then is the resulting active key used to verify checkpoint history. The trust policy must be pinned/provisioned independently. Diagnostics are read-only.

### Signed anchor-key revocation evidence (v0.32.92)

The library exposes `createNotificationRecoveryAnchorKeyRevocation` and `verifyNotificationRecoveryAnchorKeyRevocations` from `src/notification-recovery-anchor-key-revocation.js`. Revocation events are Ed25519-signed by a separately provisioned revocation authority and form an append-only hash-linked sequence. The verifier reports revoked signer IDs and fails closed on malformed, stale, future-dated, duplicated, unlinked, or incorrectly signed events.

This is currently a library API, not an automatic policy enforcement path in `anchor:diagnose`. The revocation authority public key must be pinned/provisioned out of band. A local revocation file alone cannot prove freshness or prevent rollback; use an independent trusted distribution channel or remote witness for that threat.


### Integrated signed-key revocation enforcement in diagnostics (v0.32.93)

The read-only anchor diagnostic can now verify an append-only revocation event chain against an independently provisioned Ed25519 authority public key and reject checkpoint history when its selected signer is revoked. Supply both inputs together:

```bash
npm run anchor:diagnose -- /path/checkpoint.json \
  --history /path/checkpoint-history.json \
  --trust-policy /path/anchor-trust-policy.json \
  --rotation-history /path/signed-key-rotations.json \
  --revocation-history /path/signed-revocations.json \
  --revocation-authority-public-key /path/revocation-authority.pem \
  --max-age-ms 86400000
```

Revocation evidence is enforced only when both the JSON event history and authority public key are provided. A verified revocation of the effective checkpoint signer changes the chain result to `untrusted` with `ACTIVE_SIGNER_REVOKED`. Malformed, stale, future-dated, or invalidly signed revocation evidence also fails closed. Diagnostics remain read-only. The authority key must be provisioned independently; a local signed history cannot prove freshness or prevent rollback if an attacker can replace it with an older valid copy.


### Freshness witness quorum (v0.32.96)

The read-only anchor diagnostic can verify a threshold of independent Ed25519 freshness witnesses with `--freshness-quorum-manifest`. The manifest is JSON with `schemaVersion: 1`, an integer `threshold`, and a `witnesses` array. Each entry requires `witnessPath` and `publicKeyPath` (paths are resolved relative to the manifest), and may set `expectedWitnessKeyId` and `minimumSequence`. Example:

```json
{
  "schemaVersion": 1,
  "threshold": 2,
  "witnesses": [
    { "witnessPath": "witness-a.json", "publicKeyPath": "witness-a.pem", "expectedWitnessKeyId": "witness-a-key", "minimumSequence": 42 },
    { "witnessPath": "witness-b.json", "publicKeyPath": "witness-b.pem", "expectedWitnessKeyId": "witness-b-key", "minimumSequence": 17 },
    { "witnessPath": "witness-c.json", "publicKeyPath": "witness-c.pem", "expectedWitnessKeyId": "witness-c-key", "minimumSequence": 9 }
  ]
}
```

Run it with the same checkpoint history and signer trust inputs as the normal diagnostic:

```bash
npm run anchor:diagnose -- /path/checkpoint.json \
  --history /path/history.json \
  --public-key /path/anchor-public.pem \
  --signer-key-id anchor-key-2026 \
  --freshness-quorum-manifest /path/quorum.json \
  --freshness-max-age-ms 300000 \
  --require-freshness-witness
```

The diagnostic requires the configured threshold of distinct witness IDs and key IDs to verify against the exact last checkpoint hash. A quorum manifest and a single `--freshness-witness`/`--freshness-public-key` pair are mutually exclusive. Keep the manifest, witness public keys, and membership policy outside the audited rollbackable storage domain. The quorum improves resilience to an unavailable or invalid witness, but it is not a remote witness client and cannot prevent replay if an attacker can also roll back the accepted sequence floor or the quorum membership policy.

### Integrated independent freshness witness (v0.32.95)

`src/notification-recovery-anchor-freshness-witness.js` provides signed Ed25519 freshness statements bound to a SHA-256 history-head hash and a monotonic sequence. `anchor:diagnose` now verifies that witness against the exact last checkpoint in the supplied, signature-verified history. An invalid, stale, future-dated, key-ID-mismatched, below-floor, or head-mismatched witness changes the checkpoint chain to `untrusted` and overall status to `attention_required`. Diagnostics remain read-only.

```bash
npm run anchor:diagnose -- /path/checkpoint.json \
  --history /path/checkpoint-history.json \
  --public-key /path/anchor-public.pem \
  --signer-key-id anchor-key-2026 \
  --freshness-witness /path/freshness-witness.json \
  --freshness-public-key /path/independent-witness-public.pem \
  --freshness-key-id witness-key-2026 \
  --minimum-witness-sequence 42 \
  --freshness-max-age-ms 300000 \
  --require-freshness-witness
```

The witness public key must be independently provisioned. The minimum accepted sequence must come from state protected against rollback (or another trusted external source); passing a floor from the same rollbackable storage does not prevent replay. If `--require-freshness-witness` is set without complete witness inputs, the diagnostic requires attention. The witness proves a signed statement about the supplied history head, not availability or correctness of a witness service, and this release does not implement a witness quorum or persistent anti-rollback counter.

### Remote freshness witness challenge-response (v0.32.97)

The library provides `createNotificationRecoveryAnchorWitnessChallenge`, `createNotificationRecoveryAnchorWitnessChallengeResponse`, and `verifyNotificationRecoveryAnchorWitnessChallengeResponse` in `src/notification-recovery-anchor-witness-challenge.js`. A local verifier creates a fresh challenge bound to the current history-head SHA-256, sends the nonce and expected head to a separately operated witness, and receives an Ed25519-signed response. The verifier must supply the exact nonce it issued and an independently provisioned witness public key.

Generate a fresh challenge from the current history head (the command prints JSON to stdout and does not modify the history):

```bash
npm run anchor:create-witness-challenge -- /path/history.json --ttl-ms 30000
```

Send the challenge nonce, validity window, and expected history-head hash to the separately operated witness. The witness signs a response with its Ed25519 private key. Save that response as JSON. The diagnostic command accepts the previously obtained response:

```bash
npm run anchor:diagnose -- /path/checkpoint.json \
  --history /path/history.json \
  --public-key /path/anchor-public.pem \
  --signer-key-id anchor-key-2026 \
  --freshness-challenge-response /path/response.json \
  --freshness-public-key /path/witness-public.pem \
  --freshness-challenge-nonce <64-hex-character-nonce> \
  --freshness-key-id witness-key-2026 \
  --minimum-witness-sequence 42 \
  --freshness-max-age-ms 30000 \
  --require-freshness-witness
```

Generate a new random nonce for every check and never accept a response solely because its signature is valid. The challenge-response path verifies replay binding, expiry, signer identity, sequence floor, and the exact history head. The CLI currently verifies a response supplied as a file; network transport, persistent anti-rollback storage for accepted sequences, and a remote witness service are not implemented. Challenge-response evidence therefore improves freshness validation but is not by itself a complete rollback-resistant deployment.


## Zion v0.33.3 — TLS transport hardening

The remote witness service can now serve HTTPS directly when both `ZION_WITNESS_TLS_CERT` and `ZION_WITNESS_TLS_KEY` point to PEM certificate and private-key files. Configure both or neither. Plain HTTP is permitted only when binding to `127.0.0.1`, `::1`, or `localhost`; binding to a non-loopback address without TLS fails at startup. TLS certificate issuance, renewal, trust distribution, and reverse-proxy configuration remain operator responsibilities. Keep the TLS private key readable only by the service account.

## v0.33.4 — Remote witness client

Use `npm run anchor:request-witness -- <endpoint> <history.json> <token-file> <public-key.pem> <witness-id> <key-id> <output.json> [client-id]` to request and verify a fresh signed response from a remote witness. The command hashes the latest valid checkpoint in the supplied history, creates a one-use nonce challenge, sends it with a bearer credential, verifies the response signature, witness/key identity, nonce, history-head binding, and freshness, then writes the evidence to a new JSON file with restrictive permissions. It refuses non-loopback plain HTTP and never follows redirects. Existing output files are not overwritten. For JSON credential files, pass the enabled credential's client ID as the optional final argument; plain token files do not require it. The diagnostic tool can then consume the saved evidence using its existing challenge-response and nonce options.

## Zion v0.33.5 — Shared rate limits across processes

- Replaced per-process in-memory request counters with a shared, atomically persisted rate-limit state file (`<ZION_WITNESS_STATE>.rate-limits.json`).
- Serializes updates with a dedicated lock separate from the witness sequence lock, so concurrent service processes share one IP/client quota.
- Persists state with restrictive file permissions, fsync and atomic rename; fails closed with HTTP 503 when shared limiter state or its lock is unavailable.
- Retains a bounded set of active keys and expires old windows.
- Added a multiprocess integration test proving a second process receives HTTP 429 after the shared quota is consumed.


### Zion v0.33.6 — Operational audit hardening

Remote Witness audit output is structured JSON on standard output. The logger only emits the event timestamp and approved metadata (`clientId` and a validated remote address where applicable); it does not log bearer tokens, authorization headers, request bodies, key material, filesystem paths, or arbitrary exception messages. Treat service logs as operational metadata and restrict access according to your deployment policy.

The shared rate-limit state is still shared only by service instances using the same compatible filesystem state path; it is not a cross-host distributed limiter.

### Zion v0.33.7 — Witness end-to-end verification

The test suite now exercises the complete local HTTP loopback path: start a witness service, request and verify a signed challenge response using the client, persist evidence without overwriting an existing file, then pass the evidence to read-only anchor diagnostics. The test asserts both checkpoint-chain verification and freshness verification. This validates local integration, not public-network TLS deployment or coordination across separate hosts.

## Zion v0.33.20 — Offline verification of saved Witness evidence

Use the verifier to check the Ed25519 signature and the signed response's binding to an expected Witness identity, key ID, minimum sequence, and the head hash computed from a supplied checkpoint-history file:

```sh
npm run anchor:verify-witness-evidence -- <evidence.json> <public-key.pem> <history.json> <witness-id> <key-id> [minimum-sequence]
```

The verifier rejects symlinks/non-regular inputs, files over its bounded input limit, and files whose metadata changes during inspection. It is read-only. **Offline verification is not a current freshness check:** it cannot establish that the response has not been replayed since it was issued. It also does not independently validate every checkpoint signature or establish that the supplied history is trusted by an external trust registry. For current freshness, use the live challenge flow and trusted operational policy.

## Zion v0.33.18 — Read-only Witness temporary-artifact diagnostics

After a process interruption, inspect possible temporary artifacts without modifying them:

```sh
npm run anchor:diagnose-witness-evidence -- /path/to/evidence.json

The diagnostic reads at most 1 MiB per temporary artifact. Larger files and files whose metadata changes during inspection are reported as inconclusive; their contents are not hashed or classified.
```

The diagnostic only recognizes the exact `<output-basename>.<UUID>.tmp` pattern used by the publisher. It reports whether each candidate has valid JSON syntax, whether it shares the destination's device/inode (a likely post-publication hard-link alias), its byte count, mode, and SHA-256. It does **not** validate the Witness signature or trust policy, and JSON syntax alone is not evidence of authenticity. Symlinks and non-regular files are not followed. The command is strictly read-only: it never deletes, renames, promotes, or overwrites files. Review the report and preserve artifacts before taking any manual recovery action.


## Zion v0.33.21 — Verify a trusted checkpoint history

The offline verifier checks the complete ordered checkpoint history, including each checkpoint signature, chain linkage, and strictly advancing registry revision. It resolves signer keys from an independently provisioned initial trust policy plus a complete signed rotation chain, and checks revocations signed by a separately provisioned revocation authority. The policy and authority public key must be trusted out of band; files supplied together by an untrusted party do not establish trust by themselves.

```sh
npm run anchor:verify-trusted-history -- <history.json> <trust-policy.json> <rotations.json> <revocations.json> <revocation-authority-public-key.pem>
```

Input formats: `history.json` is an ordered JSON array of checkpoint records; `trust-policy.json` is the version-1 initial policy (`signerKeyId`, `publicKeyPem`, `publicKeySha256`); `rotations.json` and `revocations.json` are ordered JSON arrays (use `[]` when empty). The revocation authority PEM is supplied separately. The verifier fails closed on missing/broken links, duplicate or non-advancing revisions, invalid signatures, unknown or revoked checkpoint signers, invalid rotation chains, and invalid revocation chains. It does not modify input files. This is offline verification: it cannot establish that the provided trust policy/revocation list is the latest published state unless the operator independently ensures freshness and authenticity.


## Zion v0.33.22 — External rollback and freshness policy

The trusted-history verifier accepts an optional externally authenticated rollback policy as its sixth input:

```bash
npm run anchor:verify-trusted-history -- history.json trust-policy.json rotations.json revocations.json revocation-authority-public-key.pem rollback-policy.json
```

Example `rollback-policy.json` (the values must come from an independently authenticated source):

```json
{
  "schemaVersion": 1,
  "minimumRevision": 42,
  "expectedLastCheckpointSha256": "<64-character-lowercase-sha256>",
  "minimumHeadIssuedAt": 1791500000000,
  "maxHeadAgeMs": 86400000
}
```

All policy fields except `schemaVersion` are optional. `minimumRevision` blocks known revision rollback; `expectedLastCheckpointSha256` pins the exact expected head; `minimumHeadIssuedAt` rejects a head older than a known issuance boundary; `maxHeadAgeMs` enforces freshness of the **latest checkpoint only**, preserving validation of older historical entries. The policy file itself must be provisioned out of band: a rollback policy bundled by an untrusted source provides no rollback protection. Without this optional file, v0.33.21 compatibility behavior remains, and the output says `rollbackPolicyApplied: false`.

### Persistent local trust-state pin

For deployments that can protect a local state directory independently of imported checkpoint bundles, the trusted-history CLI can persist the last verified head and reject revision, same-revision hash, or timestamp rollback on later runs:

```bash
npm run anchor:verify-trusted-history -- history.json trust-policy.json rotations.json revocations.json revocation-authority-public-key.pem --state-file /var/lib/zion/trusted-history-state.json
```

The state file and parent directory must not be writable by the party that can replace history bundles. A leftover `.lock` file causes verification to fail closed and must be investigated before manual removal. This local pin is not a substitute for hardware-backed monotonic storage or a remote transparency service.


### Persistent trust-state diagnostics (v0.33.24)

Run `npm run anchor:diagnose-trusted-state -- <state-file>` to inspect the local monotonic trust pin and its `.lock` file. This command is strictly read-only: it does not repair state or remove locks. A PID probe is advisory only; verify the writer/service and preserve evidence before any manual lock intervention. Never reset invalid trust state merely to make a verification pass.

### External trust-anchor receipt verification (v0.33.25)

`npm run anchor:verify-external-trust-receipt -- <receipt.json> <authority-public-key.pem> <authority-id> <revision> <checkpoint-sha256> [minimum-sequence] [max-age-ms]` verifies an Ed25519 receipt signed by an independently operated trust authority. The signed payload binds the authority ID, monotonically increasing receipt sequence, checkpoint revision, exact checkpoint hash, issuance time, and expiry. The verifier rejects stale/expired receipts, wrong authorities, mismatched heads, invalid signatures, and sequence values below the supplied minimum. Keep the public key and minimum sequence pin independent of the local history/state files. This is offline verification and does not contact or establish the honesty of the authority; freshness depends on the local clock.

### Content admission controls (v0.33.26)

- `npm run content:screen-local -- <content-file> <blacklist-hashes.json>` performs local SHA-256 exact-match screening before encryption. The JSON blacklist is an array of lowercase SHA-256 hex digests. The command does not print the digest or upload content.
- `npm run content:verify-uploader -- <signed-manifest.json> [expected-cid]` verifies an Ed25519-signed uploader attribution manifest.
- The exported `GatewayModerationRegistry` verifies signed, expiring block/unblock decisions for CIDs.
- The exported `UploadStakeLedger` is an in-memory accounting example, not a real token or consensus implementation.

**Privacy and legal caveats:** local hash screening is not a zero-knowledge proof; never assume a shared hash cannot reveal information. Signatures attribute an action to a public key, not automatically to a real-world person or legal liability. See `AUDIT_V0.33.26.md` before production use.


## Signed Witness temporary recovery

`src/witness-temp-recovery.js` provides signed sidecar metadata (Ed25519), target-content SHA-256 binding, publisher/session checks, age limits, and a fail-closed orphan recovery loop. Only `READY_FOR_COMMIT` records marked fsynced can be promoted. Commits use an atomic no-replace hard link; existing targets are preserved and conflicting or invalid temporaries are moved to forensic quarantine. Recovery events are appended to an fsynced JSONL audit file. Recovery is serialized across processes using `.witness-recovery.lock`; `.witness-replay-ledger.json` persists nonce reservations and commit state in the data root. The caller must still supply a trusted publisher-key map and a session validator connected to the live Witness token/session authority. Back up and protect the ledger with the same integrity controls as the published data; if it is corrupt, recovery intentionally stops rather than rebuilding it permissively.

This module is a local filesystem recovery primitive, not a distributed Witness consensus protocol. Directory fsync and hard-link semantics depend on the underlying filesystem/platform; use a staging directory on the same filesystem as the destination.


### Signed Witness temporary publication

`src/witness-temp-recovery.js` exports `stageWitnessTemporary()` for durable local staging. It fsyncs the content before creating a signed `READY_FOR_COMMIT` sidecar, syncs the staging directory, and returns the staging identifiers. `recoverWitnessTemporaries()` validates the signature, session callback, replay ledger, and content hash before a no-replace commit. Configure the session validator against the actual Witness authority; the default validator rejects sessions.
