---
name: p2p-protocol-testing
description: Validate peer-to-peer protocol state machines, authentication, replay protection, and failure recovery.
---
# P2P protocol testing

- Define the trust boundary and state machine for every peer-facing message and handshake.
- Authenticate peers before granting privileged operations; bind identities to sessions and intended protocol context.
- Apply replay protection, sequence checks, bounded queues, message-size limits, deadlines, and per-peer resource budgets.
- Treat peer-provided addresses and redirects as untrusted; prevent access to local/private infrastructure where applicable.
- Test adversarial peers, stale/reordered/duplicated messages, disconnects mid-handshake, malformed encodings, and concurrent reconnects.
- Use deterministic local test peers and synthetic keys; never use production credentials.
- Preserve protocol compatibility deliberately and document any wire-format changes.
