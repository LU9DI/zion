# Inactivity policy scheduler

`InactivityPolicyScheduler` periodically evaluates an `InactivityResourcePolicy`, coalesces overlapping timer ticks, exposes a status snapshot, and reports bounded errors without allowing a rejected timer callback to become an unhandled rejection.

```js
import { InactivityResourcePolicy } from '../src/inactivity-resource-policy.js';
import { InactivityPolicyScheduler } from '../src/inactivity-policy-scheduler.js';

const policy = new InactivityResourcePolicy({
  statePath: './state/inactivity-policy.json',
  getCapacity: async () => storage.getOfferedCapacityBytes(),
  setCapacity: async bytes => storage.setOfferedCapacityBytes(bytes),
  getUsage: async () => storage.getPinnedReplicaBytes(),
  notify: async event => notificationService.sendToOwner(event),
  pauseContribution: async reason => contributionService.pause(reason),
  resumeContribution: async () => contributionService.resume(),
  migrateReplicas: async request => replicaManager.migrateAndVerify(request),
});

const scheduler = new InactivityPolicyScheduler({
  policy,
  intervalMs: 60 * 60 * 1000,
  onError: async error => logger.error({ subsystem: 'inactivity-policy', ...error }),
});
scheduler.start();

// Call only after a trusted, authenticated user activity signal—not on arbitrary
// network traffic, background pings, or untrusted requests.
await scheduler.recordActivity(Date.now());

// During graceful shutdown:
scheduler.stop();
```

## Integration and safety requirements

- The example is an integration contract, not a claim that the repository already contains the named production adapters. Replace each placeholder with actual adapters and test their failure semantics before enabling it.
- The scheduler does not create a service process or persist timers. The application must instantiate it during startup and stop it during graceful shutdown.
- `recordActivity()` serializes activity after an in-flight evaluation. The host must authenticate activity before calling it.
- Notifications must be delivered through a durable owner-facing channel if delivery guarantees are required. The policy records state locally but does not provide push delivery itself.
- Storage capacity reduction must use a storage manager that can verify replica relocation and re-read usage. Never wire `migrateReplicas` to a blind deletion routine.
- The scheduler is process-local. Multiple application processes must not independently control the same capacity/state file without a cross-process lease or lock.
- This addition does not connect the cloud preview UI to a live backend and does not establish production deployment or public-network readiness.

## Official node lifecycle integration

`OfficialNodeBootstrap` accepts an optional `inactivityScheduler`. When supplied, it calls `start({ runImmediately: false })` only after integrity verification, storage startup, and successful transport binding. On startup rollback, integrity quarantine, or graceful close, it calls `stop()` before transport/storage shutdown. The scheduler is deliberately opt-in: the deployment must construct `InactivityResourcePolicy` with a durable state path and real adapters for owner notifications, contribution control, capacity, verified usage, and safe migration.

```js
const bootstrap = new OfficialNodeBootstrap({
  integrityGuard,
  transport,
  startStorage,
  stopStorage,
  inactivityScheduler: scheduler,
});
await bootstrap.start();
```

A successful bootstrap result reports `inactivityPolicy: "scheduled"` when configured and `"not-configured"` otherwise. This status confirms lifecycle scheduling only; it does not certify that the supplied adapters deliver real notifications or migrate replicas correctly. Do not wire untrusted network traffic or background pings to `scheduler.recordActivity()`.
