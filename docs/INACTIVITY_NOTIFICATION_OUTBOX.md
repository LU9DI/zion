# Durable inactivity notification outbox

`InactivityNotificationStore` stores owner-scoped inactivity notifications durably. It is a local storage primitive, not a push provider. Construct it with a private state path and wire `createInactivityNotificationAdapter()` as the `notify` callback of `InactivityResourcePolicy`.

```js
import { InactivityNotificationStore, createInactivityNotificationAdapter } from '../src/inactivity-notification-store.js';

const notificationStore = new InactivityNotificationStore({
  statePath: '/var/lib/zion/private/inactivity-notifications.json',
});
const notifyOwner = createInactivityNotificationAdapter({
  store: notificationStore,
  ownerIdentityId: authenticatedNodeOwnerIdentityId,
  // Optional provider adapter. Return { delivered: true, receipt } only when
  // the provider confirms acceptance/delivery according to its contract.
  deliver: async notification => notificationProvider.send(notification),
});
```

Without a delivery adapter, notifications are queued and remain `pending`. A provider result without a non-empty receipt never marks a notification delivered. Provider failures leave the item pending for a future retry worker. `viewedAt` is distinct from delivery status. Owner identity must come from the authenticated host context, never from untrusted request JSON.

The store caps the queue at 5,000 records by default. When full, it evicts an old delivered record only; if every record is pending it rejects enqueue rather than silently dropping an alert. State is atomically replaced with restrictive file permissions and symlink checks. File persistence is serialized within one process; deployments with multiple processes must add a shared transactional store or inter-process lock before sharing the same path.

The current release does not provide a push/email provider, retry worker, HTTP endpoints for notification history, or cross-process transaction guarantees. A persisted queue is not proof of delivery, and a provider receipt only means what that provider's contract says.
