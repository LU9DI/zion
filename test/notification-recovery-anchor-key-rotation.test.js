import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createNotificationRecoveryAnchorTrustPolicy } from '../src/notification-recovery-anchor-trust-policy.js';
import { createNotificationRecoveryAnchorKeyTransition, verifyNotificationRecoveryAnchorKeyRotation } from '../src/notification-recovery-anchor-key-rotation.js';

const pair = () => generateKeyPairSync('ed25519');
const pem = key => key.export({ type: 'spki', format: 'pem' });

test('verifies a rotation signed by the previously trusted key', () => {
  const a = pair(); const b = pair(); const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'key-a', publicKey: a.publicKey });
  const transition = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'key-a', signerKeyId: 'key-b', publicKey: b.publicKey, previousPrivateKey: a.privateKey, issuedAt: 100 });
  const result = verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [transition], now: 100 });
  assert.equal(result.valid, true); assert.equal(result.activeSignerKeyId, 'key-b'); assert.equal(result.activePublicKeySha256, transition.publicKeySha256);
});

test('rejects tampered transition and wrong previous key', () => {
  const a = pair(); const b = pair(); const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'key-a', publicKey: a.publicKey });
  const transition = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'key-a', signerKeyId: 'key-b', publicKey: b.publicKey, previousPrivateKey: a.privateKey, issuedAt: 100 });
  assert.equal(verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [{ ...transition, signerKeyId: 'key-c' }], now: 100 }).valid, false);
  assert.equal(verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [{ ...transition, previousSignerKeyId: 'wrong' }], now: 100 }).code, 'transition-previous-key-mismatch');
});

test('chains multiple rotations and rejects reused key IDs', () => {
  const a = pair(); const b = pair(); const c = pair(); const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'key-a', publicKey: a.publicKey });
  const t1 = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'key-a', signerKeyId: 'key-b', publicKey: b.publicKey, previousPrivateKey: a.privateKey, issuedAt: 100 });
  const t2 = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'key-b', signerKeyId: 'key-c', publicKey: c.publicKey, previousPrivateKey: b.privateKey, issuedAt: 101, previousTransition: t1 });
  assert.equal(verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [t1, t2], now: 101 }).activeSignerKeyId, 'key-c');
  const reuse = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'key-b', signerKeyId: 'key-a', publicKey: pem(a.publicKey), previousPrivateKey: b.privateKey, issuedAt: 101, previousTransition: t1 });
  assert.equal(verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [t1, reuse], now: 101 }).code, 'transition-key-id-reused');
});

test('rejects broken transition linkage and stale transitions', () => {
  const a = pair(); const b = pair(); const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'key-a', publicKey: a.publicKey });
  const t = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'key-a', signerKeyId: 'key-b', publicKey: b.publicKey, previousPrivateKey: a.privateKey, issuedAt: 1 });
  assert.equal(verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [t], now: 100, maxAgeMs: 5 }).code, 'transition-too-old');
  assert.equal(verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy: policy, transitions: [{ ...t, previousTransitionSha256: 'f'.repeat(64) }], now: 1 }).code, 'transition-chain-break');
});
