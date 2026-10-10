import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryCasebook } from '../src/notification-recovery-casebook.js';

const report = () => ({ schemaVersion: 1, generatedAt: new Date().toISOString(), mode: 'read-only-no-retry',
  counts: { before: 1, restored: 1, missingAfterRestore: 0, deliveryStateRegressions: 0, needsProviderReconciliation: 1,
    providerVerifiedDelivered: 0, providerVerifiedNotDelivered: 0, unresolved: 1 },
  missingAfterRestore: [], deliveryStateRegressions: [], needsProviderReconciliation: ['n1'],
  providerVerifiedDelivered: [], providerVerifiedNotDelivered: [], unresolved: ['n1'],
  automaticResendsPerformed: 0, recordsMutated: false });
const id = 'a0000000-0000-4000-8000-000000000001';

test('casebook persists reports and verifies their digest on read/list', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-casebook-'));
  const book = new NotificationRecoveryCasebook({ directory });
  const saved = book.save(report(), { caseId: id });
  assert.equal(saved.status, 'saved');
  const loaded = book.read(id);
  assert.equal(loaded.reportSha256, saved.reportSha256);
  assert.equal(loaded.report.mode, 'read-only-no-retry');
  assert.equal(book.list().length, 1);
});

test('casebook refuses duplicate case IDs without replacing the first report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-casebook-'));
  const book = new NotificationRecoveryCasebook({ directory });
  book.save(report(), { caseId: id });
  const original = readFileSync(join(directory, `case-${id}.json`), 'utf8');
  assert.throws(() => book.save(report(), { caseId: id }), error => error.code === 'NOTIFICATION_CASEBOOK_DUPLICATE_CASE');
  assert.equal(readFileSync(join(directory, `case-${id}.json`), 'utf8'), original);
});

test('casebook detects report tampering', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-casebook-'));
  const book = new NotificationRecoveryCasebook({ directory });
  book.save(report(), { caseId: id });
  const path = join(directory, `case-${id}.json`);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.report.unresolved = [];
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => book.read(id), error => error.code === 'NOTIFICATION_CASEBOOK_INTEGRITY_FAILURE');
});

test('casebook refuses symbolic-link entries and reports with retry side effects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-casebook-'));
  const book = new NotificationRecoveryCasebook({ directory });
  assert.throws(() => book.save({ ...report(), automaticResendsPerformed: 1 }), error => error.code === 'NOTIFICATION_CASEBOOK_INVALID_REPORT');
  const target = join(directory, `case-${id}.json`);
  symlinkSync(join(directory, 'missing-target'), target);
  assert.throws(() => book.read(id), error => error.code === 'NOTIFICATION_CASEBOOK_UNSAFE_FILE');
});
