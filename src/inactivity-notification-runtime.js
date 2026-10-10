import { InactivityNotificationStore, createInactivityNotificationAdapter } from './inactivity-notification-store.js';
import { InactivityNotificationDeliveryWorker } from './inactivity-notification-delivery-worker.js';
import { InactivityNotificationsHttpApi } from './inactivity-notifications-http-api.js';

/**
 * Composition root for the inactivity-notification path. Pass `notify` to
 * InactivityResourcePolicy, and pass `api` and `deliveryWorker` to
 * OfficialNodeBootstrap so network-facing services share the node lifecycle.
 * This factory does not start listeners or timers by itself.
 */
export function createInactivityNotificationRuntime({
  statePath, sessionAuthority, listOwnerIdentityIds, deliver,
  ownerIdentityId = null, host = '127.0.0.1', port = 0, allowRemoteBinding = false,
  maxRequestsPerMinute = 120, workerOptions = {}, now = () => Date.now(),
  onWorkerError = () => {},
} = {}) {
  if (typeof statePath !== 'string' || !statePath.trim()) throw new TypeError('statePath is required');
  if (ownerIdentityId !== null && (typeof ownerIdentityId !== 'string' || !ownerIdentityId.trim() || ownerIdentityId.length > 256)) {
    throw new TypeError('ownerIdentityId must be a non-empty identity string');
  }
  if (typeof listOwnerIdentityIds !== 'function' || typeof deliver !== 'function') {
    throw new TypeError('Trusted owner directory and delivery provider adapters are required');
  }
  if (typeof now !== 'function' || typeof onWorkerError !== 'function' || !workerOptions || typeof workerOptions !== 'object' || Array.isArray(workerOptions)) {
    throw new TypeError('Invalid runtime clock, worker options, or error handler');
  }
  const store = new InactivityNotificationStore({ statePath, now: () => new Date(now()).toISOString() });
  const notify = ownerIdentityId === null
    ? async () => { throw new Error('A node owner identity is required to persist inactivity notifications'); }
    : createInactivityNotificationAdapter({ store, ownerIdentityId });
  const deliveryWorker = new InactivityNotificationDeliveryWorker({
    ...workerOptions, store, listOwnerIdentityIds, deliver, now, onError: onWorkerError,
  });
  const api = new InactivityNotificationsHttpApi({ store, sessionAuthority, host, port, allowRemoteBinding, maxRequestsPerMinute, now });
  return Object.freeze({ store, notify, deliveryWorker, api });
}
