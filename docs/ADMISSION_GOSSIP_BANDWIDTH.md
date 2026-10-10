# Admission PoW, gossip and adaptive bandwidth policy

## Admission proof of work

`src/node-proof-of-work.js` implements a cancellable SHA-256 admission puzzle bound to a node's public key. The node ID remains the existing SHA-256 hash of the DER-encoded SPKI public key; proof work does not change that ID. The verifier must enforce the difficulty configured by the network, rather than trusting a difficulty claimed by a joining peer.

A difficulty of *d* leading zero bits has expected work near 2^d hashes. Wall-clock duration varies substantially by CPU, thermal state, and implementation; the software must not promise a fixed 1–2 minute duration. Difficulty 18 is only a test/default starting point, not a production network policy. PoW raises the cost of identity creation but does not prevent Sybil attacks, rented compute, botnets, or attacks against bootstrap peers. Rate limits, peer diversity, routing-table admission controls and operational monitoring remain necessary. Do not run a CPU-heavy puzzle without cancellation or progress yielding.

## Gossip and anti-entropy

`src/gossip-relay.js` provides a bounded event relay with event IDs, expiry, a maximum hop count, duplicate suppression and a bounded cache. The event ID deliberately excludes the mutable `hopsRemaining` forwarding field, so relays can decrement the hop budget without invalidating the event; a regression test checks that the next relay still accepts the forwarded event. It only carries hints such as peer observations and chunk availability. The origin signs canonical immutable event fields with Ed25519; the origin node ID is derived from the signing public key, and relays may decrement `hopsRemaining` without invalidating that signature. Event IDs exclude only mutable forwarding metadata. This authenticates origin and detects tampering, but does not prove the origin is honest, that a peer is live, or that a chunk exists. Integrators must re-check peer liveness and verify every downloaded chunk against its expected hash. The module is a building block, not a production Plumtree implementation or a claim of millisecond global propagation.

## Adaptive bandwidth

`src/adaptive-bandwidth-policy.js` computes application-level upload/download ceilings. On an active host, upload is capped at a configured fraction (default 10%) of measured available uplink; network contention tightens the budget, and missing telemetry disables contribution. On idle hosts the policy can use a larger fraction, still bounded by configured hard limits. This module does not enforce kernel traffic shaping by itself: the transfer scheduler must apply the returned budget, and production must verify enforcement against real sockets and OS traffic controls.

## Operational requirements before production

- Persist identity keys with platform-appropriate protected storage and provide rotation/revocation.
- Choose and publish network-wide PoW difficulty policy; never accept self-selected difficulty.
- Authenticate and authorize gossip events; bound event size and per-peer ingress before parsing large payloads.
- Add peer diversity and anti-eclipse controls; gossip does not replace DHT correctness.
- Test bandwidth shaping against real upload traffic, active-user transitions, telemetry loss and OS enforcement.

## Outbound enforcement in v0.32.0

`AdaptiveTransferScheduler` now provides application-level enforcement for outbound frames that pass through it. Configure `PeerTransport` with `transferScheduler`; its `send()` returns a promise when the scheduler is active. The scheduler:

- reevaluates live telemetry before draining queued frames;
- applies a byte-per-second token budget from `AdaptiveBandwidthPolicy`;
- bounds queued bytes and rejects overflow;
- rejects pending frames if telemetry is missing or the upload budget is zero;
- rejects frames whose socket is no longer writable.

This limits only writes routed through this scheduler in this Node.js process. It does **not** shape other processes, enforce inbound bandwidth, guarantee precise kernel-level throughput, or replace OS-level QoS. The caller must provide trustworthy telemetry. The Gossip relay remains a standalone helper and is not yet wired into an origin-signed gossip protocol over the transport.
