# Zion v0.33.27 — Invisible Consumer Client Facade

## Scope

Adds a consumer-facing client facade that hides chunking, encryption, content-addressing, local screening, and gateway moderation checks behind `upload()` / `download()` methods. Storage is supplied by a pluggable adapter.

## Security properties

- Performs local exact SHA-256 blacklist screening before any storage-adapter call.
- Splits content into bounded chunks and encrypts each with AES-256-GCM using a fresh random nonce and authenticated protocol label.
- Sends only ciphertext and its SHA-256 content address to the adapter; the file key is returned to the caller and is not included in the manifest.
- Manifest CID commits to canonical JSON including nested chunk entries; download validates CID, chunk ordering, sizes, ciphertext hashes, AEAD tags, and total plaintext length.
- Gateway pointer moderation is checked before download; deletion is explicit through adapter reference release and warns that replicated copies may remain.
- Upload failures trigger best-effort cleanup only when the adapter supports deletion. This is not transactional across arbitrary distributed adapters.
- Input sizes and chunk sizes are bounded. File-key working buffer is cleared on failure and after decryption; JavaScript runtimes cannot guarantee erasure of all copies.

## Validation

Local tests include round-trip, ciphertext-only adapter observation, blacklist rejection before adapter calls, nested manifest tampering, wrong keys, corrupted ciphertext, empty files, size limits, moderation blocking, and cleanup after adapter failure.

## Limitations

- `MemoryCiphertextAdapter` is a development/test adapter, not durable or distributed storage.
- This release does not implement ZKP, automatic secure key sharing, account authentication, a production network adapter, durable moderation replication, distributed transactions, or real token staking.
- The client facade does not make an app immune to its operator, client compromise, endpoint telemetry, metadata leakage, or key loss. The host app must protect the file key and any recipient key wrapping separately.
- Blacklist checks are exact-hash screening and are not proof that content is benign. A clear result means only that the digest was not in the supplied local list.
- A content CID and chunk sizes/count may reveal metadata. The CID commits to the manifest, not to the plaintext itself.
- No legal status or liability allocation is implied.
- Tests and package creation are local. No GitHub release or production deployment is performed.

## Executed checks

- `npm test`: 518 passed, 0 failed.
- `npm run check`: syntax passed for 164 JavaScript files.
- `npm run demo`: exit code 0.
- `npm run client:demo`: exit code 0; round-trip verified with 7 encrypted chunks and a ciphertext-only adapter observation.
- Package ZIP integrity and SHA-256 were checked after archive creation.
