# Inactivity notifications HTTP API

`InactivityNotificationsHttpApi` exposes the durable notification outbox to an authenticated account. It is an opt-in host adapter; creating the class does not automatically attach it to a running Zion node or public ingress.

## Routes

- `GET /api/v1/notifications/inactivity?status=all&limit=100` — list newest first. `status` is `all`, `pending`, or `delivered`; `limit` is 1–500.
- `POST /api/v1/notifications/inactivity/{uuid}/viewed` — mark an owned notification as viewed. Request bodies are not accepted.

Both routes require `Authorization: Bearer <session-token>`. The API resolves the identity from `sessionAuthority.authenticateToken()` and never accepts an identity selector from the URL or body. A notification belonging to another identity returns `404` to avoid disclosing its existence. Delivery confirmation is deliberately not exposed over HTTP; only the trusted delivery adapter should confirm a provider receipt.

Responses use `Cache-Control: no-store` and defensive headers. Public records omit owner IDs, deduplication keys, and provider receipts. The API binds to loopback by default. Set `allowRemoteBinding: true` only when deployed behind a trusted TLS-terminating ingress with suitable network policy.

## Host wiring example

```js
import { InactivityNotificationStore } from './inactivity-notification-store.js';
import { InactivityNotificationsHttpApi } from './inactivity-notifications-http-api.js';

const notificationStore = new InactivityNotificationStore({
  statePath: '/var/lib/zion/inactivity-notifications.json',
});
const notificationApi = new InactivityNotificationsHttpApi({
  store: notificationStore,
  sessionAuthority, // the same trusted session authority used by the node
  host: '127.0.0.1',
  port: 0,
});
await notificationApi.listen();
```

The host is responsible for lifecycle management, durable-volume permissions, TLS ingress, and connecting `createInactivityNotificationAdapter()` to the actual inactivity policy. The Cloud browser client is an optional API client, not a notification UI or delivery provider. No production deployment or external push/email delivery is implied.
