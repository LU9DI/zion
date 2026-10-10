import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createNotificationRecoveryAnchorFreshnessWitness, verifyNotificationRecoveryAnchorFreshnessWitness } from '../src/notification-recovery-anchor-freshness-witness.js';

const head = createHash('sha256').update('checkpoint-head').digest('hex');
const fixture = () => {
  const keys = generateKeyPairSync('ed25519');
  const witness = createNotificationRecoveryAnchorFreshnessWitness({ witnessId: 'witness-1', sequence: 8, issuedAt: 10_000, historyHeadSha256: head, witnessKeyId: 'freshness-key-1', privateKey: keys.privateKey });
  return { keys, witness };
};

test('verifies a fresh witness bound to the expected history head', () => {
  const { keys, witness } = fixture();
  const result = verifyNotificationRecoveryAnchorFreshnessWitness({ witness, publicKey: keys.publicKey, expectedWitnessKeyId: 'freshness-key-1', expectedHistoryHeadSha256: head, now: 10_100, maxAgeMs: 500 });
  assert.equal(result.valid, true);
  assert.equal(result.sequence, 8);
});

test('rejects a stale witness', () => {
  const { keys, witness } = fixture();
  assert.equal(verifyNotificationRecoveryAnchorFreshnessWitness({ witness, publicKey: keys.publicKey, now: 20_000, maxAgeMs: 500 }).code, 'witness-stale');
});

test('rejects history-head mismatch and sequence rollback', () => {
  const { keys, witness } = fixture();
  assert.equal(verifyNotificationRecoveryAnchorFreshnessWitness({ witness, publicKey: keys.publicKey, expectedHistoryHeadSha256: '0'.repeat(64), now: 10_100 }).code, 'witness-history-head-mismatch');
  assert.equal(verifyNotificationRecoveryAnchorFreshnessWitness({ witness, publicKey: keys.publicKey, minimumSequence: 9, now: 10_100 }).code, 'witness-sequence-rollback');
});

test('rejects a modified witness signature', () => {
  const { keys, witness } = fixture();
  const altered = { ...witness, historyHeadSha256: '0'.repeat(64) };
  assert.equal(verifyNotificationRecoveryAnchorFreshnessWitness({ witness: altered, publicKey: keys.publicKey, now: 10_100 }).code, 'witness-signature-invalid');
});
