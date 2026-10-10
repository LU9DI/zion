import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { createNotificationRecoveryAnchorWitnessChallenge, createNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';
import { verifyStoredWitnessEvidence } from '../scripts/verify-witness-evidence.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-offline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPath = join(dir, 'witness.pub.pem');
  const evidencePath = join(dir, 'evidence.json');
  const historyPath = join(dir, 'history.json');
  writeFileSync(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const history = [{ schemaVersion: 1, registryRevision: 1, registryStateSha256: 'a'.repeat(64), auditHeadSha256: 'b'.repeat(64), signerKeyId: 'anchor-key', issuedAt: 1000, previousCheckpointSha256: null, signature: 'test-shape-only' }];
  writeFileSync(historyPath, JSON.stringify(history));
  const head = NotificationRecoveryAuditAnchor.checkpointSha256(history[0]);
  const now = 20_000;
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: head, now: now - 1000, ttlMs: 10_000 });
  const evidence = createNotificationRecoveryAnchorWitnessChallengeResponse({ challenge, witnessId: 'witness-A', witnessKeyId: 'witness-key-A', sequence: 7, issuedAt: now - 500, privateKey: keys.privateKey });
  writeFileSync(evidencePath, JSON.stringify(evidence));
  return { dir, keys, publicKeyPath, evidencePath, historyPath, evidence, history, head };
}

test('offline verifier validates signature, witness identity, sequence and supplied history head', t => {
  const f = fixture(t);
  const result = verifyStoredWitnessEvidence({ evidencePath: f.evidencePath, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-A', expectedWitnessKeyId: 'witness-key-A', minimumSequence: 7 });
  assert.equal(result.valid, true);
  assert.equal(result.currentFreshnessProven, false);
  assert.equal(result.historyHeadSha256, f.head);
});

test('offline verifier rejects a tampered signature', t => {
  const f = fixture(t);
  writeFileSync(f.evidencePath, JSON.stringify({ ...f.evidence, signature: Buffer.from('tampered-signature').toString('base64') }));
  const result = verifyStoredWitnessEvidence({ evidencePath: f.evidencePath, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-A', expectedWitnessKeyId: 'witness-key-A' });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'challenge-signature-invalid');
});

test('offline verifier rejects wrong expected witness identity and rollback sequence', t => {
  const f = fixture(t);
  const wrongId = verifyStoredWitnessEvidence({ evidencePath: f.evidencePath, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-B', expectedWitnessKeyId: 'witness-key-A' });
  assert.equal(wrongId.code, 'challenge-witness-id-mismatch');
  const rollback = verifyStoredWitnessEvidence({ evidencePath: f.evidencePath, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-A', expectedWitnessKeyId: 'witness-key-A', minimumSequence: 8 });
  assert.equal(rollback.code, 'challenge-sequence-rollback');
});

test('offline verifier rejects evidence bound to a different history head', t => {
  const f = fixture(t);
  const alteredHistory = [{ ...f.history[0], auditHeadSha256: 'c'.repeat(64) }];
  writeFileSync(f.historyPath, JSON.stringify(alteredHistory));
  const result = verifyStoredWitnessEvidence({ evidencePath: f.evidencePath, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-A', expectedWitnessKeyId: 'witness-key-A' });
  assert.equal(result.code, 'challenge-history-head-mismatch');
});

test('offline verifier refuses symlink evidence and oversized evidence', t => {
  const f = fixture(t);
  const link = join(f.dir, 'link.json');
  symlinkSync(f.evidencePath, link);
  assert.throws(() => verifyStoredWitnessEvidence({ evidencePath: link, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-A', expectedWitnessKeyId: 'witness-key-A' }), /Evidence:.*(ELOOP|symbolic|too many levels)/i);
  writeFileSync(f.evidencePath, 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => verifyStoredWitnessEvidence({ evidencePath: f.evidencePath, publicKeyPath: f.publicKeyPath, historyPath: f.historyPath, expectedWitnessId: 'witness-A', expectedWitnessKeyId: 'witness-key-A' }), /Evidence: Input exceeds/);
});
