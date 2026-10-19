# Zion SDK v1 — application contract

This document describes the first stable consumer-facing API boundary. It is intentionally honest about the current local-storage implementation and does not imply that a production P2P network is available.

## Initialize

```js
import { ZionClient, MemoryCiphertextAdapter } from './src/zion-client.js';

const zion = new ZionClient({
  storageAdapter: new MemoryCiphertextAdapter(), // development/test only
});
```

A durable or network-backed adapter must implement `putChunk({ id, ciphertext })` and `getChunk(id)`. Do not use the in-memory adapter for production data.

## Store and retrieve

```js
const stored = await zion.store(fileBytes);
const restored = await zion.download({
  cid: stored.cid,
  manifest: stored.manifest,
  fileKey: stored.fileKey,
});
```

- `store` is the application-facing name for the existing encrypted upload operation.
- Chunks are encrypted client-side with AES-256-GCM before they reach the adapter.
- The returned `fileKey` is a secret. It must be delivered to authorized recipients through a separate authenticated secure channel and must not be logged or published with the manifest.
- The manifest CID commits to its metadata; it is not an account identity or proof of remote availability.
- The current adapter boundary may be local. Successful `store` alone does not prove independent remote replication.

## Verify a storage receipt

```js
const result = zion.verify(signedReceipt, originalStoreRequest);
if (!result.ok) {
  throw new Error(`Invalid storage receipt: ${result.reason}`);
}
```

Verification checks the peer signature, derives the signer identity from its public key, and binds the signed acknowledgement to the exact store request (request ID, target node, chunk digest, byte count, and validity window). Historical receipts remain verifiable offline; live freshness and replay rejection are handled by the receipt tracker when accepting new network messages. Keep the original request alongside the receipt.

A valid receipt proves only that the identified peer signed a matching storage acknowledgement. It is **not** a cryptographic proof that the peer still retains the bytes, that the data is physically durable, or that the peer will be online later. Read-back verification, periodic challenges, independent peers, and repair/re-replication remain separate work.

## Current API boundary

- `store(input, options?)`: encrypt and write chunks through the configured adapter; returns the CID, manifest, client-held file key, and screening result.
- `upload(input, options?)`: compatibility name for `store`.
- `download({ cid?, manifest, fileKey })`: validates the manifest and each ciphertext chunk before decrypting.
- `verify(signedReceipt, originalStoreRequest, options?)`: stateless signature and request-binding validation.
- `delete(cid, manifest)`: releases references only if the adapter supports it; it cannot guarantee deletion of other replicas or recipient copies.

This is the first SDK contract increment. Key lifecycle, remote peer discovery, NAT traversal, recovery, durable remote proof, and a production transport adapter are not included in this increment.
