# REA Cloud Rust migration boundary

## Current release

The v0.16.0 change introduces `rust-core/` as an independently testable Rust crate. Node.js remains the active application runtime and the existing `OpaqueReplicaStore` is still the active store path. There is no FFI, N-API addon, or sidecar protocol wired up yet.

## Stable storage operations

| Operation | Rust API | Required invariant |
|---|---|---|
| Initialize | `StorageCore::init()` | Root is a real directory; restrictive Unix mode where available |
| Store | `put(chunk_id, envelope)` | Owner quota, maximum block size, REAC1 marker, SHA-256, atomic no-overwrite |
| Retrieve | `get(chunk_id)` | Validate content address and envelope before returning |
| Usage | `used_bytes()` / `quota_bytes()` | Report stored payload bytes and configured local ceiling |

The native boundary must map `CapacityExhausted { available_bytes }` to the existing protocol outcome `STORE_REJECTED / CAPACITY_EXHAUSTED`. Remote peers must never be able to change local quota configuration.

## Integration plan

1. Run Rust unit tests and platform-specific storage tests in CI on Linux, Windows, and macOS.
2. Add cross-language fixtures to ensure JavaScript and Rust agree on REAC1 validation, digest IDs, maximum sizes, and error mapping.
3. Introduce an explicit adapter interface behind `OpaqueReplicaStore`; keep the JavaScript implementation as a fallback until parity tests pass.
4. Run race/crash tests for concurrent writes, lock timeout, interrupted writes, full disk, symlink substitution, and process termination.
5. Add OS-enforced disk quotas/volume isolation and verify the actual filesystem boundary before claiming a hard quota.
6. Enable Rust by default only after the adapter is exercised by the complete Node test suite and platform CI.

## Non-goals

The migration does not require a central database, cloud account, blockchain, or remote execution. Rust memory safety does not replace protocol validation, OS resource isolation, or operational security review.

## v0.17.0: opt-in sidecar boundary

The repository now contains a `rea-storage-cli` binary and `RustStorageAdapter` wrapper. The wrapper requires an explicit binary path and explicit local quotas, limits child-process runtime and output size, validates content-address syntax before launching the child, and maps capacity exhaustion to a typed error. This creates a testable integration boundary without pretending the Rust binary is already deployed.

Current limitation: the adapter remains opt-in and is not yet wired into `OpaqueReplicaStore`. Node-side adapter tests use a controlled fake process; they validate the contract and error mapping, not the Rust binary itself. Compile and execute Rust unit/integration tests with Cargo before enabling the sidecar in a real deployment.
