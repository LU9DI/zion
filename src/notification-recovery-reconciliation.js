/**
 * Build a side-effect-free reconciliation report after restoring a notification outbox.
 * This module never contacts a provider, retries delivery, or mutates supplied records.
 * Callers should pass only the minimum record fields needed for reconciliation.
 */
const STATUSES = new Set(['pending', 'ambiguous', 'delivered']);
const OUTCOMES = new Set(['delivered', 'not-delivered', 'unknown']);

function validateRecords(records, label) {
  if (!Array.isArray(records) || records.length > 5000) throw new TypeError(`Invalid ${label} records`);
  const byId = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim() || record.id.length > 256 ||
        typeof record.ownerIdentityId !== 'string' || !record.ownerIdentityId.trim() || record.ownerIdentityId.length > 256 ||
        !STATUSES.has(record.deliveryStatus)) throw new TypeError(`Invalid ${label} record`);
    const key = `${record.ownerIdentityId}\0${record.id}`;
    if (byId.has(key)) throw new TypeError(`Duplicate ${label} record identity`);
    byId.set(key, Object.freeze({ id: record.id, ownerIdentityId: record.ownerIdentityId, deliveryStatus: record.deliveryStatus }));
  }
  return byId;
}

/**
 * @param {{beforeRecords: Array, restoredRecords: Array, providerEvidence?: Array}} input
 * providerEvidence entries: {ownerIdentityId, id, outcome, receipt?}. A delivered outcome
 * is considered verified only when a non-empty receipt is supplied. Evidence is advisory:
 * this function reports it but never changes an outbox or triggers a resend.
 */
export function buildNotificationRecoveryReconciliationReport({ beforeRecords, restoredRecords, providerEvidence = [] } = {}) {
  const before = validateRecords(beforeRecords, 'pre-recovery');
  const restored = validateRecords(restoredRecords, 'restored');
  if (!Array.isArray(providerEvidence) || providerEvidence.length > 10_000) throw new TypeError('Invalid provider evidence');
  const evidence = new Map();
  for (const item of providerEvidence) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || typeof item.ownerIdentityId !== 'string' || !item.ownerIdentityId.trim() ||
        !OUTCOMES.has(item.outcome) || (item.outcome === 'delivered' && (typeof item.receipt !== 'string' || !item.receipt.trim() || item.receipt.length > 256))) {
      throw new TypeError('Invalid provider evidence entry');
    }
    const key = `${item.ownerIdentityId}\0${item.id}`;
    if (evidence.has(key)) throw new TypeError('Duplicate provider evidence identity');
    evidence.set(key, Object.freeze({ outcome: item.outcome, receiptVerified: item.outcome === 'delivered' && Boolean(item.receipt?.trim()) }));
  }

  const missingAfterRestore = [];
  const deliveryStateRegressions = [];
  const needsProviderReconciliation = [];
  const verifiedDelivered = [];
  const verifiedNotDelivered = [];
  const unresolved = [];
  const keyOf = item => `${item.ownerIdentityId}\0${item.id}`;

  for (const [key, prior] of before) {
    const current = restored.get(key);
    if (!current) {
      missingAfterRestore.push(prior.id);
      if (prior.deliveryStatus === 'delivered') deliveryStateRegressions.push(prior.id);
      continue;
    }
    if (prior.deliveryStatus === 'delivered' && current.deliveryStatus !== 'delivered') deliveryStateRegressions.push(current.id);
  }

  for (const [key, current] of restored) {
    const prior = before.get(key);
    const provider = evidence.get(key);
    if (provider?.outcome === 'delivered' && provider.receiptVerified) {
      verifiedDelivered.push(current.id);
      continue;
    }
    if (provider?.outcome === 'not-delivered') {
      verifiedNotDelivered.push(current.id);
      continue;
    }
    if (provider?.outcome === 'unknown' || current.deliveryStatus === 'ambiguous' ||
        (prior?.deliveryStatus === 'delivered' && current.deliveryStatus !== 'delivered')) {
      needsProviderReconciliation.push(current.id);
      unresolved.push(current.id);
    }
  }

  const sorted = values => [...new Set(values)].sort();
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'read-only-no-retry',
    counts: {
      before: before.size,
      restored: restored.size,
      missingAfterRestore: sorted(missingAfterRestore).length,
      deliveryStateRegressions: sorted(deliveryStateRegressions).length,
      needsProviderReconciliation: sorted(needsProviderReconciliation).length,
      providerVerifiedDelivered: sorted(verifiedDelivered).length,
      providerVerifiedNotDelivered: sorted(verifiedNotDelivered).length,
      unresolved: sorted(unresolved).length,
    },
    missingAfterRestore: sorted(missingAfterRestore),
    deliveryStateRegressions: sorted(deliveryStateRegressions),
    needsProviderReconciliation: sorted(needsProviderReconciliation),
    providerVerifiedDelivered: sorted(verifiedDelivered),
    providerVerifiedNotDelivered: sorted(verifiedNotDelivered),
    unresolved: sorted(unresolved),
    automaticResendsPerformed: 0,
    recordsMutated: false,
  };
  return Object.freeze({ ...report, counts: Object.freeze(report.counts),
    missingAfterRestore: Object.freeze(report.missingAfterRestore),
    deliveryStateRegressions: Object.freeze(report.deliveryStateRegressions),
    needsProviderReconciliation: Object.freeze(report.needsProviderReconciliation),
    providerVerifiedDelivered: Object.freeze(report.providerVerifiedDelivered),
    providerVerifiedNotDelivered: Object.freeze(report.providerVerifiedNotDelivered),
    unresolved: Object.freeze(report.unresolved) });
}
