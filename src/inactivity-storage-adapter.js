/**
 * Adapts an OpaqueReplicaStore to InactivityResourcePolicy's storage callbacks.
 * Contribution pause/resume, notifications, and safe replica migration remain
 * explicit host-provided adapters; this module never deletes data or guesses that
 * relocation succeeded.
 */
export function createInactivityStorageAdapter({ store, migrateReplicas = async () => false } = {}) {
  if (!store || typeof store.getCapacityBytes !== 'function' || typeof store.setCapacityBytes !== 'function' ||
      typeof store.auditInventory !== 'function' || typeof migrateReplicas !== 'function') {
    throw new TypeError('Invalid inactivity storage adapter configuration');
  }
  return Object.freeze({
    getCapacity: async () => store.getCapacityBytes(),
    setCapacity: async bytes => store.setCapacityBytes(bytes),
    getUsage: async () => {
      const report = await store.auditInventory();
      if (!Number.isSafeInteger(report?.verifiedBytes) || report.verifiedBytes < 0) {
        throw new Error('Verified replica inventory did not return a valid byte count');
      }
      return report.verifiedBytes;
    },
    migrateReplicas: async request => migrateReplicas(request),
  });
}
