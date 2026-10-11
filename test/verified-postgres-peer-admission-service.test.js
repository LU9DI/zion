import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';
import { VerifiedPostgresPeerAdmissionService } from '../src/verified-postgres-peer-admission-service.js';

test('verifies vouchers before calling the PostgreSQL store', async () => {
  const issuers = [createNodeIdentity(), createNodeIdentity(), createNodeIdentity()];
  const subject = createNodeIdentity();
  const vouchers = issuers.slice(0, 2).map(issuer =>
    createPeerIntroductionVoucher({ issuerIdentity: issuer, subjectNodeId: subject.nodeId }));
  const calls = [];
  const service = new VerifiedPostgresPeerAdmissionService({
    store: { commitAdmission: async input => { calls.push(input); return { ok: true }; } },
    trustedIssuerNodeIds: issuers.map(x => x.nodeId),
    threshold: 2,
    storageHeadroomProvider: async () => 0.5,
  });
  assert.equal((await service.admit({ subjectNodeId: subject.nodeId, vouchers })).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(new Set(calls[0].issuerNodeIds), new Set(issuers.slice(0, 2).map(x => x.nodeId)));
  assert.deepEqual(calls[0].invitations.map(x => x.nonce), vouchers.map(x => x.nonce));
});

test('rejects duplicate issuers and subject-mismatched vouchers', async () => {
  const issuers = [createNodeIdentity(), createNodeIdentity()];
  const subject = createNodeIdentity();
  const vouchers = issuers.map(issuer => createPeerIntroductionVoucher({
    issuerIdentity: issuer, subjectNodeId: subject.nodeId,
  }));
  let calls = 0;
  const service = new VerifiedPostgresPeerAdmissionService({
    store: { commitAdmission: async () => { calls++; return { ok: true }; } },
    trustedIssuerNodeIds: issuers.map(x => x.nodeId),
    threshold: 2,
    storageHeadroomProvider: async () => 0.5,
  });
  assert.equal((await service.admit({ subjectNodeId: subject.nodeId,
    vouchers: [vouchers[0], { ...vouchers[0], nonce: 'f'.repeat(32) }] })).reason,
  'insufficient-valid-invitations');
  assert.equal((await service.admit({ subjectNodeId: createNodeIdentity().nodeId, vouchers })).reason,
    'insufficient-valid-invitations');
  assert.equal(calls, 0);
});

test('fails closed when storage headroom is unavailable', async () => {
  const issuers = [createNodeIdentity(), createNodeIdentity()];
  const subject = createNodeIdentity();
  const vouchers = issuers.map(issuer => createPeerIntroductionVoucher({
    issuerIdentity: issuer, subjectNodeId: subject.nodeId,
  }));
  const service = new VerifiedPostgresPeerAdmissionService({
    store: { commitAdmission: async () => ({ ok: true }) },
    trustedIssuerNodeIds: issuers.map(x => x.nodeId),
    threshold: 2,
    storageHeadroomProvider: async () => NaN,
  });
  assert.deepEqual(await service.admit({ subjectNodeId: subject.nodeId, vouchers }),
    { ok: false, reason: 'capacity-unavailable' });
});
