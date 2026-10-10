# Initial threat model

## Protected assets

- Plaintext content and encryption keys.
- Owner machine responsiveness, disk space, network allowance, power, and thermal safety.
- Integrity and availability of stored ciphertext.
- Peer identity and placement metadata.

## Threats

Malicious peers can send corrupt blocks, lie about capacity, churn offline, attempt Sybil/eclipse attacks, flood repair requests, or infer metadata from timing and placement. A compromised owner endpoint can expose plaintext and keys. Supply-chain compromise can subvert the client. Losing all replicas causes data loss.

## Current mitigations

Authenticated encryption (AES-256-GCM), ciphertext content hashes, strict owner ceilings in the policy layer, fail-closed telemetry, advisory placement across failure domains, and no remote code execution.

## Gaps before public network

Authenticated signed manifests, peer authentication, rate-limited protocols, Sybil resistance, privacy analysis, secure update/signing process, fuzzing, independent security review, and verifiable OS resource enforcement. Hashes alone do not establish who authorized a manifest. This prototype is not suitable for sensitive or sole-copy data.

## Bitcoin-inspired network defenses

The protocol foundation now includes Ed25519-signed peer messages, public-key-derived node IDs, timestamp freshness checks, nonce-based replay rejection, bounded message sizes, and per-peer token-bucket admission control. These are building blocks, not a complete network security boundary. A future transport must additionally enforce connection caps, handshake timeouts, packet/frame limits, bounded queues, peer diversity, backoff, and abuse telemetry. The optional trust allowlist establishes which node IDs may send accepted messages to this listener, but requires secure out-of-band distribution of those IDs. Node identity alone does not establish a trusted authorization relationship or prevent Sybil attacks, and local rate limits do not stop distributed denial of service. Rate limiting precedes replay-cache insertion so over-budget traffic does not consume replay-cache capacity. Replay-cache expiry uses a min-heap rather than scanning every cached nonce per message, reducing the routine expiry cost from linear to logarithmic. An attacker controlling many identities can still exhaust shared resources within configured limits.

## Transport layer (experimental)

`src/peer-transport.js` provides bounded newline-delimited TCP frames and authenticates each message with the Ed25519 envelope. It defaults to `127.0.0.1`; binding to a non-loopback interface requires an explicit `trustedPeerIds` allowlist of SHA-256 node IDs. It limits concurrent sockets, frame sizes, and queued handler work per socket; checks timestamp/signature/node-ID binding; applies per-peer admission control before replay-cache insertion; rejects replayed messages; and allowlists protocol message types. It does not provide TLS, peer discovery, NAT traversal, connection encryption, global Sybil resistance, or operating-system resource isolation. Stored data must remain client-side encrypted, and message handlers must independently validate authorization, quota, chunk hashes, and storage paths. Do not expose this experimental transport directly to the public internet.


## DHT adapter timeout behavior

The injected provider-discovery boundary applies a hard deadline to local availability checks, content announcements, and provider iteration. It aborts the supplied signal on timeout and best-effort closes the async iterator. Adapters should honor `AbortSignal`; JavaScript cannot forcibly terminate an arbitrary injected promise that ignores cancellation. This protects callers from waiting indefinitely, but does not replace adapter-level cancellation, peer quotas, or live-network tests.
