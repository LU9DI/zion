import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher, verifyPeerIntroductionVouchers } from '../src/peer-introduction-vouchers.js';

test('requires distinct pre-trusted introducers and verifies subject binding', () => {
  const a = createNodeIdentity(), b = createNodeIdentity(), c = createNodeIdentity(), subject = createNodeIdentity();
  const va = createPeerIntroductionVoucher({ issuerIdentity:a, subjectNodeId:subject.nodeId, issuedAt:1000, expiresAt:5000, nonce:'a'.repeat(32) });
  const vb = createPeerIntroductionVoucher({ issuerIdentity:b, subjectNodeId:subject.nodeId, issuedAt:1000, expiresAt:5000, nonce:'b'.repeat(32) });
  const result = verifyPeerIntroductionVouchers({ subjectNodeId:subject.nodeId, vouchers:[va,va,vb], trustedIssuerNodeIds:[a.nodeId,b.nodeId,c.nodeId], threshold:2, now:2000 });
  assert.equal(result.ok,true);
  assert.equal(result.trustedIntroductions,2);
  assert.equal(verifyPeerIntroductionVouchers({ subjectNodeId:subject.nodeId, vouchers:[va], trustedIssuerNodeIds:[a.nodeId,b.nodeId], threshold:2, now:2000 }).ok,false);
});

test('rejects tampering, wrong subject, expired vouchers, and untrusted issuer', () => {
  const issuer = createNodeIdentity(), subject = createNodeIdentity(), other = createNodeIdentity();
  const v = createPeerIntroductionVoucher({ issuerIdentity:issuer, subjectNodeId:subject.nodeId, issuedAt:1000, expiresAt:2000, nonce:'c'.repeat(32) });
  const check = args => verifyPeerIntroductionVouchers({ subjectNodeId:subject.nodeId, vouchers:[v], trustedIssuerNodeIds:[issuer.nodeId], threshold:1, now:1500, ...args });
  assert.equal(check({ vouchers:[{...v, subjectNodeId:other.nodeId}] }).ok,false);
  assert.equal(check({ now:3000 }).ok,false);
  assert.equal(check({ trustedIssuerNodeIds:[other.nodeId] }).ok,false);
  assert.equal(check({ vouchers:[{...v, expiresAt:1999}] }).ok,false);
});
