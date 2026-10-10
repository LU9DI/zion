# Experimental peer storage protocol

This module is an integration step for local testing, not a public-network release.

## Flow

1. The owner encrypts data into a REAC1 envelope and computes SHA-256 over the complete envelope.
2. The sender creates a time-bounded `STORE_REQUEST` bound to the intended storage node, digest, and envelope byte count.
3. `PeerStorageService.sendStoreChunk()` splits the envelope into bounded base64 segments. Each frame is signed by the sender's Ed25519 identity.
4. The receiving service bounds transfer count and buffered bytes, checks consistent segment metadata, validates the envelope magic and digest, then persists the opaque bytes.
5. Only after persistence does the receiver send a signed `STORE_RECEIPT`. The sender validates it with `ReplicaReceiptTracker`.
6. `GET_CHUNK` requests the opaque envelope; the requester checks the returned digest before handing it to the owner's decryption layer.

## Guarantees and non-guarantees

- Storage nodes do not need the content-encryption key and do not decrypt the envelope.
- Signatures authenticate the peer identity and prevent undetected message modification. They do not prove the peer keeps the data after sending a receipt.
- A digest detects corruption only when the expected digest comes from a trusted manifest or request.
- The storage quota in `OpaqueReplicaStore` is application-level and currently serialized within one instance. It is not an OS-enforced quota and is not robust against a malicious process running as the same OS user.
- TCP messages are signed but the transport is not encrypted at the connection layer. Keep the listener on loopback and do not expose it to the internet.
- Peer discovery, NAT traversal, connection encryption, durable receipt tracking, proof-of-retrievability, repair orchestration, and verified Windows/macOS resource enforcement are not implemented.


## Capacity exhaustion (v0.15.0)

When the local replica quota has no room for a new unique envelope, the receiver responds with a signed `STORE_REJECTED` payload containing the matching `requestId`, `chunkId`, `code: CAPACITY_EXHAUSTED`, and a non-negative `availableBytes` estimate. The coordinator accepts this only from the node and for the chunk/request it is waiting on, marks the attempt as failed, and tries another ranked eligible node if available. This is not an eviction command; existing data is not discarded to make room.
