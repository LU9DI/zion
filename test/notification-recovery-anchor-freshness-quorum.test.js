import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createNotificationRecoveryAnchorFreshnessWitness } from '../src/notification-recovery-anchor-freshness-witness.js';
import { verifyNotificationRecoveryAnchorFreshnessQuorum } from '../src/notification-recovery-anchor-freshness-quorum.js';

const head = createHash('sha256').update('same-trusted-head').digest('hex');
function member(id) {
  const keys = generateKeyPairSync('ed25519');
  return {
    witness: createNotificationRecoveryAnchorFreshnessWitness({ witnessId: id, sequence: 7, issuedAt: 50_000, historyHeadSha256: head, witnessKeyId: `${id}-key`, privateKey: keys.privateKey }),
    publicKey: keys.publicKey,
    expectedWitnessKeyId: `${id}-key`,
    minimumSequence: 5
  };
}

test('accepts a quorum of distinct witnesses bound to the same history head', () => {
  const result = verifyNotificationRecoveryAnchorFreshnessQuorum({ witnesses: [member('w1'), member('w2'), member('w3')], threshold: 2, expectedHistoryHeadSha256: head, now: 50_100, maxAgeMs: 500 });
  assert.equal(result.valid, true);
  assert.equal(result.verifiedCount, 3);
  assert.equal(result.threshold, 2);
});

test('rejects quorum when fewer than threshold witnesses verify', () => {
  const a = member('w1');
  const b = member('w2');
  b.witness = { ...b.witness, historyHeadSha256: '0'.repeat(64) };
  const result = verifyNotificationRecoveryAnchorFreshnessQuorum({ witnesses: [a, b], threshold: 2, expectedHistoryHeadSha256: head, now: 50_100 });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'quorum-threshold-not-met');
  assert.equal(result.verifiedCount, 1);
});

test('rejects duplicated witness identities and keys', () => {
  const a = member('w1');
  const result = verifyNotificationRecoveryAnchorFreshnessQuorum({ witnesses: [a, { ...a }], threshold: 2, expectedHistoryHeadSha256: head, now: 50_100 });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'quorum-membership-duplicate-or-malformed');
});

test('rejects invalid threshold configuration', () => {
  assert.equal(verifyNotificationRecoveryAnchorFreshnessQuorum({ witnesses: [member('w1')], threshold: 2, expectedHistoryHeadSha256: head, now: 50_100 }).code, 'quorum-configuration-invalid');
});
