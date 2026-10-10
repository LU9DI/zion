import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryCasebook } from '../src/notification-recovery-casebook.js';
import { NotificationRecoverySignedDecisionStore } from '../src/notification-recovery-signed-decisions.js';

const caseId = 'a0000000-0000-4000-8000-000000000001';
const decisionId = 'c0000000-0000-4000-8000-000000000001';
const keyId = 'operator-key-1';
const now = Date.parse('2026-10-09T12:00:00.000Z');
const report = () => ({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), mode: 'read-only-no-retry',
  counts: { before: 1, restored: 1, missingAfterRestore: 0, deliveryStateRegressions: 0, needsProviderReconciliation: 1, providerVerifiedDelivered: 0, providerVerifiedNotDelivered: 0, unresolved: 1 },
  missingAfterRestore: [], deliveryStateRegressions: [], needsProviderReconciliation: ['n1'], providerVerifiedDelivered: [], providerVerifiedNotDelivered: [], unresolved: ['n1'], automaticResendsPerformed: 0, recordsMutated: false });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zion-signed-decision-'));
  const casebook = new NotificationRecoveryCasebook({ directory: join(root, 'cases') });
  const saved = casebook.save(report(), { caseId });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const store = new NotificationRecoverySignedDecisionStore({ casebook, directory: join(root, 'signed-decisions'), trustedPublicKeys: { [keyId]: publicKey } });
  const request = { caseId, expectedReportSha256: saved.reportSha256, action: 'authorize_manual_retry', approver: 'operator:test', rationale: 'Provider evidence reviewed; manual retry may be considered.', keyId, privateKey, decisionId, now };
  return { root, casebook, saved, store, publicKey, privateKey, request };
}

test('signs and verifies Ed25519 decision bound to exact report digest without executing delivery', () => {
  const { store, request } = setup();
  const signed = store.signDecision(request);
  assert.equal(signed.executionPerformed, false);
  assert.equal(store.read(decisionId, { now: now + 1000 }).approvalValid, true);
  assert.equal(store.list({ now: now + 1000 }).length, 1);
});

test('rejects private key that does not match trusted public key', () => {
  const { store, request } = setup();
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => store.signDecision({ ...request, privateKey: other }), error => error.code === 'NOTIFICATION_SIGNED_DECISION_KEY_MISMATCH');
});

test('rejects stale report digest and duplicate decision ID', () => {
  const { store, request } = setup();
  assert.throws(() => store.signDecision({ ...request, expectedReportSha256: '0'.repeat(64) }), error => error.code === 'NOTIFICATION_SIGNED_DECISION_STALE_REPORT');
  store.signDecision(request);
  assert.throws(() => store.signDecision(request), error => error.code === 'NOTIFICATION_SIGNED_DECISION_DUPLICATE');
});

test('detects signature tampering and expiry', () => {
  const { store, request, root } = setup();
  store.signDecision(request);
  const path = join(root, 'signed-decisions', `signed-decision-${decisionId}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.rationale = 'Tampered rationale after approval.';
  writeFileSync(path, JSON.stringify(record));
  assert.throws(() => store.read(decisionId, { now: now + 1000 }), error => error.code === 'NOTIFICATION_SIGNED_DECISION_INTEGRITY_FAILURE');
  const second = setup();
  second.store.signDecision({ ...second.request, decisionId: 'c0000000-0000-4000-8000-000000000002', ttlMs: 1000 });
  assert.equal(second.store.read('c0000000-0000-4000-8000-000000000002', { now: now + 1000 }).status, 'expired');
});

test('revoked keys cannot sign and existing signatures no longer authorize decisions', () => {
  const { casebook, root, saved, publicKey, privateKey, request } = setup();
  const store = new NotificationRecoverySignedDecisionStore({ casebook, directory: join(root, 'revoked'), trustedPublicKeys: { [keyId]: publicKey } });
  store.signDecision(request);
  const revoked = new NotificationRecoverySignedDecisionStore({ casebook, directory: join(root, 'revoked'), trustedPublicKeys: { [keyId]: publicKey }, revokedKeyIds: [keyId] });
  assert.equal(revoked.read(decisionId, { now: now + 1000 }).status, 'revoked-key');
  assert.throws(() => revoked.signDecision({ ...request, decisionId: 'c0000000-0000-4000-8000-000000000003' }), error => error.code === 'NOTIFICATION_SIGNED_DECISION_KEY_REVOKED');
});

test('rejects signed decision if its case report becomes stale', () => {
  const { store, request, casebook, root } = setup();
  store.signDecision(request);
  const path = join(root, 'cases', `case-${caseId}.json`);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.report.unresolved = [];
  envelope.reportSha256 = createHash('sha256').update(JSON.stringify(envelope.report)).digest('hex');
  writeFileSync(path, JSON.stringify(envelope));
  assert.equal(casebook.read(caseId).reportSha256, envelope.reportSha256);
  assert.equal(store.read(decisionId, { now: now + 1000 }).status, 'stale-invalidated');
});
