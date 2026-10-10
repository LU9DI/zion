# Inactivity notification runtime composition

`createInactivityNotificationRuntime()` is the composition root for the notification path introduced across the 0.32.46–0.32.50 releases. It creates a persistent outbox, owner-scoped policy callback, authenticated history API, and bounded delivery worker from host-supplied adapters.

```js
import { createInactivityNotificationRuntime } from '../src/inactivity-notification-runtime.js';
import { InactivityResourcePolicy } from '../src/inactivity-resource-policy.js';
import { InactivityPolicyScheduler } from '../src/inactivity-policy-scheduler.js';
import { OfficialNodeBootstrap } from '../src/official-node-bootstrap.js';

const notifications = createInactivityNotificationRuntime({
  statePath: '/var/lib/zion/inactivity-notifications.json',
  ownerIdentityId: nodeIdentity.id,
  sessionAuthority, // trusted bearer-token authority
  listOwnerIdentityIds: async () => ownerDirectory.listActiveIdentityIds(),
  deliver: notificationProvider.deliver, // must return { delivered: true, receipt: '...' } only with provider evidence
  host: '127.0.0.1',
  port: 0,
});

const policy = new InactivityResourcePolicy({
  statePath: '/var/lib/zion/inactivity-policy.json',
  notify: notifications.notify,
  // Provide real activity, contribution, and storage callbacks here.
  getCapacity, getUsage, pauseContribution, resumeContribution, setCapacity, migrateReplicas,
});
const scheduler = new InactivityPolicyScheduler({ policy });
const bootstrap = new OfficialNodeBootstrap({
  integrityGuard, transport, startStorage, stopStorage, getStorageStatus,
  inactivityScheduler: scheduler,
  notificationDeliveryWorker: notifications.deliveryWorker,
  notificationApi: notifications.api,
});
await bootstrap.start();
```

The snippet is an integration contract, not a runnable deployment configuration: all host adapters, identity authority, provider credentials, integrity material, storage, and transport must be supplied and independently secured. Keep the API on loopback unless a trusted TLS ingress is explicitly configured. Do not pass the same delivery worker to multiple bootstraps. The runtime factory does not start services; the official bootstrap starts the API and worker only after successful integrity, storage, and transport startup and closes them during rollback/shutdown/quarantine.

The policy callback requires a real `ownerIdentityId`; when omitted, the runtime intentionally rejects notification events instead of assigning them to an ambiguous owner. The outbox is local-file-backed and does not provide cross-process locking; run one writer per state file or replace the storage adapter with a transactional database before multi-process deployment. Delivery is at-least-once, not exactly-once. A provider must return a trustworthy receipt, and the host must implement provider-specific idempotency if duplicates are unacceptable.
