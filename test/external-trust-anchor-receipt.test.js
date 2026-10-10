import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createExternalTrustAnchorReceipt, verifyExternalTrustAnchorReceipt } from '../src/external-trust-anchor-receipt.js';

const setup = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const receipt = createExternalTrustAnchorReceipt({ authorityId: 'transparency-prod', sequence: 17, revision: 42, checkpointSha256: 'a'.repeat(64), issuedAt: 10_000, ttlMs: 30_000, privateKey });
  return { publicKey, privateKey, receipt };
};
const verifyIt = (receipt, publicKey, overrides = {}) => verifyExternalTrustAnchorReceipt({ receipt, publicKey, expectedAuthorityId: 'transparency-prod', expectedRevision: 42, expectedCheckpointSha256: 'a'.repeat(64), now: 15_000, maxAgeMs: 20_000, ...overrides });

test('accepts a correctly signed fresh receipt bound to the exact head', () => {
  const { publicKey, receipt } = setup(); const result = verifyIt(receipt, publicKey);
  assert.equal(result.valid, true); assert.equal(result.sequence, 17); assert.equal(result.currentFreshnessProven, true);
});
test('rejects invalid signatures and payload tampering', () => {
  const { publicKey, receipt } = setup();
  assert.equal(verifyIt({ ...receipt, revision: 43 }, publicKey).code, 'revision-mismatch');
  assert.equal(verifyIt({ ...receipt, sequence: 18 }, publicKey).code, 'receipt-signature-invalid');
});
test('rejects authority, head, and sequence rollback mismatches', () => {
  const { publicKey, receipt } = setup();
  assert.equal(verifyIt(receipt, publicKey, { expectedAuthorityId: 'other' }).code, 'authority-id-mismatch');
  assert.equal(verifyIt(receipt, publicKey, { expectedCheckpointSha256: 'b'.repeat(64) }).code, 'checkpoint-hash-mismatch');
  assert.equal(verifyIt(receipt, publicKey, { minimumSequence: 18 }).code, 'external-sequence-rollback');
});
test('rejects expired, stale, and future-issued receipts', () => {
  const { publicKey, receipt } = setup();
  assert.equal(verifyIt(receipt, publicKey, { now: 50_001 }).code, 'receipt-stale-or-outside-validity-window');
  assert.equal(verifyIt(receipt, publicKey, { now: 40_001, maxAgeMs: 60_000 }).code, 'receipt-stale-or-outside-validity-window');
  assert.equal(verifyIt(receipt, publicKey, { now: 9_999 }).code, 'receipt-stale-or-outside-validity-window');
});
test('rejects malformed receipts and non-Ed25519 keys', () => {
  const { publicKey, receipt } = setup();
  assert.equal(verifyIt({ ...receipt, sequence: 0 }, publicKey).code, 'receipt-malformed');
  const { publicKey: rsaKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(verifyIt(receipt, rsaKey).code, 'authority-public-key-invalid');
});
