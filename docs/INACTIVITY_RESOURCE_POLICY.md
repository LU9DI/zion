# Inactivity-based contribution and capacity policy

`InactivityResourcePolicy` is an experimental, opt-in policy controller for a Zion node. It deliberately separates owner activity from storage safety.

## Defaults

- At 7 days idle: notify that contribution will pause at day 14.
- At 14 days idle: pause contributed-resource work through the configured adapter.
- At 30 days idle: notify that offered capacity may be reduced in 7 more days.
- At 37 days idle: request a 50% reduction of offered capacity.
- On renewed activity: clear the inactivity cycle, resume contribution if it was paused, and restore the previous offered-capacity value if it had been reduced.

Durations and reduction factor can be configured. All durations must be at least one day and thresholds must be ordered.

## Safety invariants

- Notification is emitted before pause and before capacity reduction.
- The controller does not delete user files and does not evict replicas itself.
- If occupied bytes exceed the target offer, `migrateReplicas` must prove safe migration and the usage check must then fit the target. Otherwise reduction stays pending and the old capacity is retained.
- Missing or inconsistent capacity/usage telemetry fails closed.
- Policy state is atomically written to a regular file with restrictive permissions; symlink state files are rejected.
- A node integration must wire `pauseContribution`, `resumeContribution`, capacity callbacks, notification delivery and migration to real, independently verified services. The controller alone does not prove that OS resources have stopped or replicas have migrated.

## API sketch

```js
const policy = new InactivityResourcePolicy({
  statePath: './state/inactivity-policy.json',
  getCapacity: async () => currentOfferedBytes,
  setCapacity: async bytes => updateOfferedCapacity(bytes),
  getUsage: async () => currentReplicaBytes,
  notify: async event => deliverOwnerNotification(event),
  pauseContribution: async reason => pauseContributionServices(reason),
  resumeContribution: async () => resumeContributionServices(),
  migrateReplicas: async ({ targetBytes, usedBytes }) => migrateAndVerifyReplicas(targetBytes, usedBytes),
});
await policy.evaluate();
// Call markActivity() only after a verified user activity signal.
```

The UI preview describes the policy but is not yet wired to a running remote node. Do not represent this module as a production scheduler until service adapters, notification delivery, and replica migration have been integrated and tested across restarts and network failures.


## Storage adapter integration (experimental)

`createInactivityStorageAdapter({ store, migrateReplicas })` provides `getCapacity`, `setCapacity`, `getUsage`, and `migrateReplicas` callbacks for `InactivityResourcePolicy`. Usage comes from a content-address-verified inventory audit. The store rejects a quota reduction if actual occupied bytes exceed the target, and the policy re-reads usage after a migration callback returns success.

**Important limitation:** the quota is durable and coordinated among store instances sharing the same storage root, but production startup wiring, durable owner-facing notifications, contribution pause/resume adapters, and real migration are still required. The adapter never deletes replicas.
