# Rust storage lifecycle integration

The Rust sidecar is invoked as a bounded one-shot process for each operation. It does not have a persistent child process to supervise, so Zion needs a logical lifecycle gate that prevents storage calls before startup and after node shutdown/quarantine.

## Wiring

```js
import { RustStorageAdapter } from '../src/rust-storage-adapter.js';
import { RustStorageLifecycle, rustStorageBootstrapHooks } from '../src/rust-storage-lifecycle.js';
import { PeerStorageService } from '../src/peer-storage-service.js';
import { OfficialNodeBootstrap } from '../src/official-node-bootstrap.js';

const adapter = new RustStorageAdapter({
  binaryPath: '/absolute/path/to/zion-storage',
  root: '/absolute/path/to/private-replica-root',
  maxChunkBytes: 4 * 1024 * 1024,
  maxStorageBytes: 1024 * 1024 * 1024,
});
const storage = new RustStorageLifecycle(adapter);
const storageHooks = rustStorageBootstrapHooks(storage);

// Use `storage` as the store passed to PeerStorageService so the lifecycle gate
// is applied to actual peer requests, not only to the bootstrap status display.
const peerStorage = new PeerStorageService({ identity, store: storage });

// Pass ...storageHooks into OfficialNodeBootstrap together with integrity and
// transport adapters. Bootstrap starts storage after integrity verification
// and stops it during rollback, close, and quarantine containment.
```

## Guarantees

- Operations fail with `ZION_STORAGE_NOT_RUNNING` before startup, during shutdown, or after stop.
- Shutdown rejects new calls and waits for in-flight storage operations to finish before reporting stopped.
- Startup failures remain visible and can be retried while the lifecycle is stopped.
- `getStorageStatus()` reports the wrapper's logical state and active operation count.

## Limitations

- The wrapper does not replace `OfficialNodeBootstrap` or automatically wire itself into a running application; the deployment must pass its hooks and use the wrapper as the actual store.
- The sidecar is one-shot per command; status means the logical adapter is enabled, not that a long-lived Rust process exists.
- This is not OS-level resource enforcement, does not solve filesystem portability concerns, and does not make replication acknowledgements proof of remote durability.

## Filesystem lock recovery and operator procedure

The Rust storage root is private state. Do not edit it while the sidecar or any process sharing that root is active. The active coordination directory is `.rea-rust-storage-lock`; temporary chunk files live inside two-character shard directories. The stale-lock reaper may preserve a `.rea-rust-storage-lock.stale-*` quarantine directory if it cannot prove that the moved directory is the exact stale lock it inspected and the shared lock path has already been recreated. This is deliberately fail-closed: quota scans reject unknown root entries rather than silently omitting potentially unaccounted bytes.

If storage starts returning `UnsafePath` and a stale-lock quarantine entry is present:

1. Stop all Zion processes and sidecars that can access the storage root; confirm no service supervisor restarts them.
2. Take a filesystem-level snapshot or backup of the entire root before changing anything.
3. Inspect the quarantine directory and its `owner` file without following symlinks. Do not assume its name proves that it is safe to delete.
4. Compare its contents with the active lock and application logs. Preserve evidence when ownership or identity is ambiguous; do not recursively delete an unverified directory.
5. Only after independently confirming that no process is using the root and retaining a recoverable backup, move the artifact out of the live root for offline analysis. Restart and verify storage health and quota accounting before resuming writes.

This is a manual recovery procedure, not automatic self-healing. The payload quota is not an OS disk quota; use filesystem permissions and an OS-enforced quota for stronger containment against unrelated local writers.
