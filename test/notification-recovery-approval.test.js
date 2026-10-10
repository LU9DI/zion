import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryCasebook } from '../src/notification-recovery-casebook.js';
import { NotificationRecoveryApprovalWorkflow } from '../src/notification-recovery-approval.js';

const caseId = 'a0000000-0000-4000-8000-000000000001';
const decisionId = 'b0000000-0000-4000-8000-000000000001';
const report = () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), mode: 'read-only-no-retry',
  counts: { before: 1, restored: 1, missingAfterRestore: 0, deliveryStateRegressions: 0, needsProviderReconciliation: 1, providerVerifiedDelivered: 0, providerVerifiedNotDelivered: 0, unresolved: 1 },
  missingAfterRestore: [], deliveryStateRegressions: [], needsProviderReconciliation: ['n1'], providerVerifiedDelivered: [], providerVerifiedNotDelivered: [], unresolved: ['n1'], automaticResendsPerformed: 0, recordsMutated: false });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zion-approval-'));
  const casebook = new NotificationRecoveryCasebook({ directory: join(root, 'cases') });
  const saved = casebook.save(report(), { caseId });
  const workflow = new NotificationRecoveryApprovalWorkflow({ casebook, directory: join(root, 'decisions') });
  return { root, casebook, saved, workflow };
}
const request = saved => ({ caseId, expectedReportSha256: saved.reportSha256, action: 'authorize_manual_retry', approver: 'operator:test', rationale: 'Provider evidence reviewed; manual retry may be considered.', decisionId });

test('approval is durably recorded against the exact case digest without executing a retry', () => {
  const { workflow, saved } = setup();
  const result = workflow.approve(request(saved));
  assert.equal(result.status, 'recorded');
  assert.equal(result.executionPerformed, false);
  assert.equal(workflow.read(decisionId).approvalValid, true);
  assert.equal(workflow.list().length, 1);
});

test('approval rejects a stale report digest', () => {
  const { workflow, saved } = setup();
  assert.throws(() => workflow.approve({ ...request(saved), expectedReportSha256: '0'.repeat(64) }), error => error.code === 'NOTIFICATION_APPROVAL_STALE_REPORT');
});

test('approval record becomes invalid if the case report changes, even when its envelope digest is recomputed', () => {
  const { workflow, casebook, saved, root } = setup();
  workflow.approve(request(saved));
  const path = join(root, 'cases', `case-${caseId}.json`);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.report.unresolved = [];
  envelope.reportSha256 = createHash('sha256').update(JSON.stringify(envelope.report)).digest('hex');
  writeFileSync(path, JSON.stringify(envelope));
  assert.ok(casebook.read(caseId));
  const decision = workflow.read(decisionId);
  assert.equal(decision.status, 'stale-invalidated');
  assert.equal(decision.approvalValid, false);
});

