# Architecture status

## Implemented in this prototype

1. **ResourceGovernor** calculates a conservative per-node work budget from local telemetry and owner-configured ceilings. Missing telemetry disables work. Production mode requires a verified OS enforcement adapter.
2. **EncryptedChunkStore** encrypts each chunk with AES-256-GCM, stores only ciphertext, and addresses the encrypted envelope by SHA-256.
3. **Replica planner** produces advisory placements across distinct failure domains and reports under-replication.
4. **Peer security** signs messages and manifests with Ed25519, binds node IDs to public keys, validates timestamps, and rejects replayed messages using a bounded nonce cache with heap-based expiry.
5. **Experimental TCP transport** uses bounded frames/connections, message-type allowlisting, per-peer rate limits, and loopback-only binding by default.

## Client-side content admission

`ZionClient` performs an exact SHA-256 blacklist check before encryption. It also supports an injected local malware-scanner adapter; when `requireMalwareScan: true`, upload fails closed unless the scanner returns the exact `clean` verdict. The ClamAV CLI adapter streams plaintext locally before encryption, uses bounded archive-scan settings, and does not invoke a shell. The scanner copy and the client's internal plaintext copy are best-effort zeroized. Zion does not bundle the ClamAV executable or signature database: production applications must install and maintain the engine and pass the real-engine integration test on the target deployment. Hash matching alone is not malware detection. See `docs/LOCAL_CONTENT_SCREENING.md`.

## Not implemented yet

- A running libp2p node with Kademlia DHT, bootstrap diversity, NAT traversal, and secure remote deployment. `src/dht-provider-discovery.js` is only an injected adapter/policy boundary, not a deployed DHT.
- Encrypted key sharing/recovery and metadata privacy.
- OS-specific resource enforcement and independent verification.
- Durable replica receipts, repair leases, anti-Sybil measures, and repair-storm controls.
- Erasure coding, garbage collection protocol, and retention/secure deletion semantics.

## Network model

No central database or blockchain is required by the local core. The experimental transport is not yet a complete P2P network. As discovery is added, local nodes should make placement and admission decisions from authenticated observations, with bounded gossip and multiple bootstrap peers. Bootstrap peers aid discovery but must not be authoritative. Replication must be verified by receipts, not inferred from a placement plan. Repair jobs need concurrency caps, jitter, exponential backoff, and hysteresis.


## Experimental replication receipts (v0.9.0)

`src/replication-receipts.js` binds a signed storage acknowledgement to a one-time request ID, target node identity, chunk digest, expected byte count, and validity window. Pending requests and accepted receipts are bounded. A request is consumed after one accepted acknowledgement, preventing duplicate counting. This is bookkeeping and peer-authenticated acknowledgement only: it does not prove durable persistence, prevent a malicious node from lying, or itself transfer/store ciphertext. Integration with a verified remote storage handler and end-to-end recovery tests remains future work.

## Transport backpressure

Each TCP socket processes authenticated messages sequentially and accepts at most 64 queued frames while a handler is running. This bounds application-level work per connection and prevents a fast peer from creating an unbounded number of concurrent async handler calls. Queue overflow closes the connection. This is local backpressure, not network-wide DDoS protection; public exposure still requires encrypted transport, peer admission controls, and deployment-level network protections.


## DHT provider discovery boundary

The experimental `DhtProviderDiscovery` announces only chunks reported locally available by its caller, bounds provider results, enforces hard timeouts for local availability checks, announcements, and provider iteration (including iterators that stall), and treats returned provider records as untrusted. Timeout cancellation is best-effort: injected adapters must honor `AbortSignal`, and a stalled implementation may continue work internally if it ignores cancellation. `Libp2pContentRoutingAdapter` wraps a supplied libp2p ContentRouting API and an injected chunk-ID-to-CID function. No libp2p dependencies are currently installed and no live DHT is started by Zion; provider discovery, bootstrap, re-announcement, peer authentication, ciphertext verification, and internet-level resilience must be integrated and tested before public use.


## Content-admission security boundary

The local ClamAV integration is a client-side pre-encryption safeguard for honest clients. It is not a network-wide enforcement mechanism: a hostile or modified client can bypass it or lie about a scan result, and a signed client attestation cannot prove that scanning really occurred. Storage peers cannot conventionally scan E2E-encrypted plaintext without gaining access to plaintext or decryption capability. Consequently, the current scanner does not guarantee that malicious content cannot enter the distributed network. Network-wide malware inspection would require an explicitly trusted inspection boundary and a documented privacy trade-off. Until such a design is implemented and independently validated, describe the feature only as local upload screening, not a decentralized malware firewall.
