import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createNotificationRecoveryAnchorWitnessChallenge, createNotificationRecoveryAnchorWitnessChallengeResponse, verifyNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

const head = createHash('sha256').update('fresh-checkpoint').digest('hex');
const fixture = () => {
  const keys = generateKeyPairSync('ed25519');
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: head, now: 10_000, ttlMs: 5_000 });
  const response = createNotificationRecoveryAnchorWitnessChallengeResponse({ challenge, witnessId: 'remote-witness-1', witnessKeyId: 'remote-key-1', sequence: 19, issuedAt: 10_100, privateKey: keys.privateKey });
  return { keys, challenge, response };
};

test('verifies a signed response bound to a fresh challenge nonce and exact history head', () => {
  const { keys, challenge, response } = fixture();
  const result = verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey: keys.publicKey, expectedWitnessId: 'remote-witness-1', expectedWitnessKeyId: 'remote-key-1', expectedNonce: challenge.nonce, expectedHistoryHeadSha256: head, now: 10_200, maxResponseAgeMs: 500, minimumSequence: 19 });
  assert.equal(result.valid, true);
  assert.equal(result.sequence, 19);
});

test('rejects replay against a newly generated nonce', () => {
  const { keys, response } = fixture();
  const result = verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey: keys.publicKey, expectedNonce: 'a'.repeat(64), expectedHistoryHeadSha256: head, now: 10_200, maxResponseAgeMs: 500 });
  assert.equal(result.code, 'challenge-nonce-mismatch');
});

test('rejects expired challenges and divergent history heads', () => {
  const { keys, challenge, response } = fixture();
  assert.equal(verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey: keys.publicKey, expectedNonce: challenge.nonce, now: 15_001, maxResponseAgeMs: 500 }).code, 'challenge-expired');
  assert.equal(verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey: keys.publicKey, expectedNonce: challenge.nonce, expectedHistoryHeadSha256: '0'.repeat(64), now: 10_200, maxResponseAgeMs: 500 }).code, 'challenge-history-head-mismatch');
});

test('rejects modified signed response and sequence rollback', () => {
  const { keys, challenge, response } = fixture();
  assert.equal(verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response: { ...response, sequence: 20 }, publicKey: keys.publicKey, expectedNonce: challenge.nonce, now: 10_200, maxResponseAgeMs: 500 }).code, 'challenge-signature-invalid');
  assert.equal(verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey: keys.publicKey, expectedNonce: challenge.nonce, now: 10_200, minimumSequence: 20 }).code, 'challenge-sequence-rollback');
});

test('challenge creation rejects excessive TTL and malformed head hash', () => {
  assert.throws(() => createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: head, now: 1, ttlMs: 300_001 }), /Invalid witness challenge options/);
  assert.throws(() => createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'bad', now: 1 }), /Invalid witness challenge options/);
});
