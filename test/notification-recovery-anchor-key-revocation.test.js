import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createNotificationRecoveryAnchorKeyRevocation, verifyNotificationRecoveryAnchorKeyRevocations } from '../src/notification-recovery-anchor-key-revocation.js';

const pair = () => generateKeyPairSync('ed25519');
test('verifies signed revocation events and reports revoked identities', () => {
  const authority = pair();
  const a = createNotificationRecoveryAnchorKeyRevocation({ eventId: 'rev-1', revokedSignerKeyId: 'anchor-key-7', reasonCode: 'KEY_COMPROMISED', issuedAt: 100, authorityPrivateKey: authority.privateKey });
  const b = createNotificationRecoveryAnchorKeyRevocation({ eventId: 'rev-2', revokedSignerKeyId: 'anchor-key-8', reasonCode: 'KEY_RETIRED', issuedAt: 101, previousEvent: a, authorityPrivateKey: authority.privateKey });
  const result = verifyNotificationRecoveryAnchorKeyRevocations({ events: [a, b], authorityPublicKey: authority.publicKey, now: 101 });
  assert.equal(result.valid, true); assert.deepEqual(result.revokedSignerKeyIds, ['anchor-key-7', 'anchor-key-8']);
});
test('fails closed on tampering, broken linkage, stale and duplicate events', () => {
  const authority = pair();
  const a = createNotificationRecoveryAnchorKeyRevocation({ eventId: 'rev-1', revokedSignerKeyId: 'anchor-key-7', reasonCode: 'KEY_COMPROMISED', issuedAt: 100, authorityPrivateKey: authority.privateKey });
  assert.equal(verifyNotificationRecoveryAnchorKeyRevocations({ events: [{ ...a, reasonCode: 'KEY_RETIRED' }], authorityPublicKey: authority.publicKey, now: 100 }).code, 'revocation-signature-invalid');
  assert.equal(verifyNotificationRecoveryAnchorKeyRevocations({ events: [a, a], authorityPublicKey: authority.publicKey, now: 100 }).code, 'revocation-event-id-reused');
  assert.equal(verifyNotificationRecoveryAnchorKeyRevocations({ events: [a], authorityPublicKey: authority.publicKey, now: 200, maxAgeMs: 10 }).code, 'revocation-too-old');
});
test('rejects invalid authority keys', () => {
  assert.equal(verifyNotificationRecoveryAnchorKeyRevocations({ events: [], authorityPublicKey: 'not a key' }).code, 'revocation-authority-invalid');
});
