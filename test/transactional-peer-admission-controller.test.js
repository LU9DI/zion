import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';
import { TransactionalPeerAdmissionController } from '../src/transactional-peer-admission-controller.js';

function setup(overrides = {}) {
  const issuerA = createNodeIdentity();
  const issuerB = createNodeIdentity();
  const subject = createNodeIdentity();
  const vouchers = [
    createPeerIntroductionVoucher({ issuerIdentity: issuerA, subjectNodeId: subject.nodeId }),
    createPeerIntroductionVoucher({ issuerIdentity: issuerB, subjectNodeId: subject.nodeId }),
  ];
  const calls = [];
  const store = {
    commitAdmission: async input => {
      calls.push(input);
      return { ok: true, subjectNodeId: input.subjectNodeId, trustedIntroductions: input.issuerNodeIds.length, issuerNodeIds: input.issuerNodeIds };
    },
    isAdmitted: async id => id === subject.nodeId,
    snapshot: async () => ({ consumedInvitations: 2, admittedPeers: 1 }),
    releaseAdmission: async (id, status) => ({ ok: true, changed: true, subjectNodeId: id, status }),
  };
  const config = {
    trustedIssuerNodeIds: [issuerA.nodeId, issuerB.nodeId],
    threshold: 2,
    maxActivePeers: 10,
    maxAdmissionsPerIssuer: 4,
    minStorageHeadroomRatio: 0.1,
    capacityProvider: async () => ({ activePeers: 1, maxPeers: 10, storageHeadroomRatio: 0.5 }),
    admissionStore: store,
    ...overrides,
  };
  return { controller: new TransactionalPeerAdmissionController(config), config, store, calls, subject, vouchers, issuerA, issuerB };
}

test('transactional controller verifies vouchers before delegating atomic admission', async () => {
  const x = setup();
  const result = await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers });
  assert.equal(result.ok, true);
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].issuerNodeIds, x.vouchers.map(v => v.issuerNodeId));
  assert.deepEqual(x.calls[0].invitations, x.vouchers.map(v => ({ issuerNodeId: v.issuerNodeId, nonce: v.nonce })));
  assert.equal(x.calls[0].storageHeadroomRatio, 0.5);
  assert.equal(x.calls[0].maxActivePeers, 10);
});

test('transactional controller rejects untrusted, malformed, and repeated-issuer vouchers', async () => {
  const x = setup();
  const outsider = createNodeIdentity();
  const untrusted = createPeerIntroductionVoucher({ issuerIdentity: outsider, subjectNodeId: x.subject.nodeId });
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: [x.vouchers[0], untrusted] })).reason, 'insufficient-valid-invitations');
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: [x.vouchers[0], x.vouchers[0]] })).reason, 'insufficient-valid-invitations');
  assert.equal(x.calls.length, 0);
});

test('transactional controller fails closed on unavailable capacity and enforces rollout', async () => {
  const x = setup({ capacityProvider: async () => null });
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers })).reason, 'capacity-unavailable');
  const y = setup({ rolloutPolicy: { evaluate: () => ({ allowed: false, reason: 'rollout-paused' }) } });
  assert.equal((await y.controller.admit({ subjectNodeId: y.subject.nodeId, vouchers: y.vouchers })).reason, 'rollout-paused');
  assert.equal(y.calls.length, 0);
});

test('transactional controller exposes asynchronous authoritative state and release operations', async () => {
  const x = setup();
  assert.equal(await x.controller.isAdmitted(x.subject.nodeId), true);
  assert.equal(await x.controller.isAdmitted('invalid'), false);
  assert.deepEqual(await x.controller.snapshot(), { consumedInvitations: 2, admittedPeers: 1 });
  assert.deepEqual(await x.controller.release(x.subject.nodeId, 'revoked'), {
    ok: true, changed: true, subjectNodeId: x.subject.nodeId, status: 'revoked',
  });
});
