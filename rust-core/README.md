# REA Cloud Rust storage core (experimental)

This crate is the first Rust implementation of the opaque encrypted-block storage boundary. It is intentionally separate from the current Node.js runtime until native integration and cross-language conformance tests are available.

## API contract

- `StorageCore::new(root, max_chunk_bytes, max_storage_bytes)` accepts owner-configured limits only.
- `init()` validates the root and restricts Unix directory permissions where supported.
- `put(sha256_hex, encrypted_envelope)` validates the REAC1 envelope, digest, maximum block size and quota before an atomic no-overwrite write. Capacity failure is `StorageError::CapacityExhausted` with available bytes.
- `get(sha256_hex)` validates the stored envelope and digest before returning bytes.
- `used_bytes()` and `quota_bytes()` expose payload accounting for local diagnostics.

The API never accepts quota changes from peer messages. The Rust code does not hold user encryption keys and does not execute stored content.

## Build and test

Requires Rust/Cargo and access to the `sha2` crate on the first build:

```sh
cargo test --manifest-path rust-core/Cargo.toml
```

## Important limitations

- The Rust crate is not yet wired into the Node.js `OpaqueReplicaStore`; the existing JavaScript path remains the active runtime path in this release.
- This quota counts stored payload files, not filesystem metadata, unrelated files, logs, or all transient disk usage. It is not an OS-enforced disk boundary.
- The directory lock coordinates cooperating instances but is not a security boundary against a malicious process running as the same OS user. Crash-stale lock recovery is deliberately conservative and currently requires operator intervention.
- A dedicated filesystem/volume or kernel-enforced quota, platform-specific enforcement, and adversarial multi-process tests are still required before describing the storage ceiling as hard.
- The current implementation is an experimental foundation; do not expose the peer transport to the public internet.

## Optional Node.js sidecar boundary (v0.17.0)

A small `rea-storage-cli` binary exposes `init`, `put`, `get`, and `usage` over a bounded command-line/stdin contract. The Node adapter in `src/rust-storage-adapter.js` invokes an explicitly configured binary and maps quota failures to typed errors. It does not silently fall back to JavaScript.

Build the binary with:

```sh
cargo build --release --manifest-path rust-core/Cargo.toml --bin rea-storage-cli
```

Then construct `RustStorageAdapter` with the path to the built binary and owner-chosen local quota values. CI builds the binary and runs `test/rust-storage-integration.test.js` against the real executable, covering init, put/get read-back, usage accounting, and fail-closed quota exhaustion through the Node adapter. The adapter remains opt-in and must be explicitly injected into `PeerStorageService`; this Linux CI test does not replace cross-platform, crash-recovery, or hostile-concurrency testing.
