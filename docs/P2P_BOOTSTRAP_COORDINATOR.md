# P2P bootstrap coordinator — first network increment

This module adds a bounded coordinator for connecting to multiple authenticated bootstrap peers across configured failure domains. It is a prerequisite for a resilient network, not a substitute for the actual libp2p/Kademlia runtime.

## Contract

- Configure at least two distinct peer IDs and at least two distinct failure-domain labels.
- Provide a `dialPeer(peer, { signal })` adapter that resolves only after the transport authenticates the remote peer and returns its actual peer ID plus `authenticated: true`.
- Provide `disconnectPeer(peerId)` so failed startup, mismatched identities and late timeout completions can be cleaned up.
- The coordinator enforces a dial timeout, concurrency ceiling, minimum number of connected peers, and minimum number of successful failure domains.
- A bootstrap failure is not silently treated as network readiness.

## Example

```js
const coordinator = new P2PBootstrapCoordinator({
  bootstrapPeers: [
    { peerId: 'peer-a', failureDomain: 'region-a', multiaddrs: ['/ip4/192.0.2.1/tcp/4001'] },
    { peerId: 'peer-b', failureDomain: 'region-b', multiaddrs: ['/ip4/198.51.100.2/tcp/4001'] },
  ],
  dialPeer: async (peer, { signal }) => {
    // Adapter-specific authenticated dial. Verify actual remote peer ID.
    return { peerId: peer.peerId, authenticated: true };
  },
  disconnectPeer: async peerId => { /* close that authenticated connection */ },
});
await coordinator.start();
```

## Important limitations

- Failure-domain labels are operator-supplied metadata, not cryptographic proof that operators or infrastructure are independent.
- This coordinator does not implement Kademlia DHT, NAT traversal, relay reservation, peer-address exchange, or a libp2p transport. Those remain the next network increments.
- It is not wired into the official node runtime automatically; the deployment must integrate it with a real authenticated peer dialer and lifecycle.
- A peer identity is useful only if the dial adapter actually verifies it. The `authenticated: true` result is a contract with the adapter, not a security feature on its own.
