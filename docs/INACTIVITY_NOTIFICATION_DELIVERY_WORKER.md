# Inactivity notification delivery worker

`InactivityNotificationDeliveryWorker` drains a durable `InactivityNotificationStore` for explicitly supplied owner identities. It is an opt-in host integration, not a push/email provider by itself.

## Wiring

Construct the worker with:

- `store`: the same durable outbox instance (or a compatible store) used by the policy notification adapter and history API.
- `listOwnerIdentityIds()`: a trusted server-side source of owner identities authorized for this node. Never derive this list from a browser request. A worker is intentionally not allowed to scan arbitrary owner identities from untrusted input.
- `deliver(notification)`: provider adapter returning `{ delivered: true, receipt: "..." }` only when it has a verifiable delivery receipt. Any other response leaves the record pending.

Pass it as `notificationDeliveryWorker` to `OfficialNodeBootstrap`. Bootstrap starts it only after integrity verification, storage startup, and transport startup. It stops and drains the worker before closing transport/storage during shutdown or integrity quarantine.

## Retry behavior

- Defaults: 30-second polling, exponential retry beginning at 30 seconds and capped at six hours, maximum 12 attempts per record, up to 100 pending records per owner per run.
- Failed delivery remains `pending`; no record is falsely marked delivered.
- Records at the attempt ceiling remain pending and are counted as `exhausted` for operator intervention. This release does not implement a dead-letter queue or automatic alerting for exhausted items.
- Concurrent calls to `runOnce()` coalesce. `stop()` is terminal for this worker instance and waits for the current run to settle.
- The owner list, provider, identity directory, credentials, rate limits, privacy requirements, and any provider-side idempotency must be supplied and operated by the host.

The worker does not guarantee exactly-once delivery: a provider can accept a message and fail before returning its receipt. Providers should support idempotency keys (the notification ID) when possible. No production provider or deployment is included in this package.
