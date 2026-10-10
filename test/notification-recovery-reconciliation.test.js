import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotificationRecoveryReconciliationReport } from '../src/notification-recovery-reconciliation.js';

const record = (id, deliveryStatus, ownerIdentityId = 'owner-a') => ({ id, ownerIdentityId, deliveryStatus, message: 'must not appear' });

test('reconciliation report detects records missing from restored snapshot and delivered-state regressions', () => {
  const report = buildNotificationRecoveryReconciliationReport({
    beforeRecords: [record('lost-pending', 'pending'), record('lost-delivered', 'delivered'), record('regressed', 'delivered')],
    restoredRecords: [record('regressed', 'pending')],
  });
  assert.deepEqual(report.missingAfterRestore, ['lost-delivered', 'lost-pending']);
  assert.deepEqual(report.deliveryStateRegressions, ['lost-delivered', 'regressed']);
  assert.equal(report.automaticResendsPerformed, 0);
  assert.equal(report.recordsMutated, false);
  assert.equal(JSON.stringify(report).includes('must not appear'), false);
});

test('provider evidence is reported without retrying or mutating records', () => {
  const before = [record('a', 'ambiguous'), record('b', 'ambiguous'), record('c', 'pending')];
  const restored = structuredClone(before);
  const beforeJSON = JSON.stringify(restored);
  const report = buildNotificationRecoveryReconciliationReport({ beforeRecords: before, restoredRecords: restored,
    providerEvidence: [
      { ownerIdentityId: 'owner-a', id: 'a', outcome: 'delivered', receipt: 'receipt-1' },
      { ownerIdentityId: 'owner-a', id: 'b', outcome: 'not-delivered' },
      { ownerIdentityId: 'owner-a', id: 'c', outcome: 'unknown' },
    ] });
  assert.deepEqual(report.providerVerifiedDelivered, ['a']);
  assert.deepEqual(report.providerVerifiedNotDelivered, ['b']);
  assert.deepEqual(report.needsProviderReconciliation, ['c']);
  assert.equal(JSON.stringify(restored), beforeJSON);
});

test('delivered evidence without a receipt is rejected', () => {
  assert.throws(() => buildNotificationRecoveryReconciliationReport({ beforeRecords: [], restoredRecords: [],
    providerEvidence: [{ ownerIdentityId: 'owner-a', id: 'a', outcome: 'delivered' }] }), /Invalid provider evidence entry/);
});

test('duplicate record identities and invalid statuses are rejected', () => {
  assert.throws(() => buildNotificationRecoveryReconciliationReport({ beforeRecords: [record('a', 'pending'), record('a', 'pending')], restoredRecords: [] }), /Duplicate/);
  assert.throws(() => buildNotificationRecoveryReconciliationReport({ beforeRecords: [], restoredRecords: [record('a', 'sent')] }), /Invalid restored record/);
});

test('owner scoping prevents same notification id across owners from colliding', () => {
  const report = buildNotificationRecoveryReconciliationReport({
    beforeRecords: [record('same', 'delivered', 'owner-a')],
    restoredRecords: [record('same', 'pending', 'owner-b')],
  });
  assert.deepEqual(report.missingAfterRestore, ['same']);
  assert.deepEqual(report.deliveryStateRegressions, ['same']);
});

test('report is immutable and rejects oversized inputs', () => {
  const report = buildNotificationRecoveryReconciliationReport({ beforeRecords: [], restoredRecords: [] });
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.counts), true);
  assert.throws(() => buildNotificationRecoveryReconciliationReport({ beforeRecords: new Array(5001), restoredRecords: [] }), /Invalid pre-recovery records/);
});
