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
