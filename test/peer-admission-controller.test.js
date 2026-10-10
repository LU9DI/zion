import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';
import { PeerAdmissionController } from '../src/peer-admission-controller.js';

function memoryStore(initial = null) {
  let state = initial;
  return {
    load: () => state === null ? null : structuredClone(state),
    save: next => { state = structuredClone(next); },
  };
}
function setup(options = {}) {
  const a = createNodeIdentity(), b = createNodeIdentity(), c = createNodeIdentity();
  const subject = createNodeIdentity();
  const vouchers = [
    createPeerIntroductionVoucher({ issuerIdentity: a, subjectNodeId: subject.nodeId }),
    createPeerIntroductionVoucher({ issuerIdentity: b, subjectNodeId: subject.nodeId }),
  ];
  const store = options.store ?? memoryStore();
  const config = {
    trustedIssuerNodeIds: [a.nodeId, b.nodeId, c.nodeId], threshold: 2,
    capacityProvider: async () => ({ activePeers: 1, maxPeers: 10, storageHeadroomRatio: 0.5 }),
    stateStore: store, ...options,
  };
  return { controller: new PeerAdmissionController(config), subject, vouchers, store, config, issuers: [a, b] };
}

test('admits with distinct trusted vouchers and restores admission state after restart', async () => {
  const x = setup();
  const result = await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers });
  assert.equal(result.ok, true);
  assert.equal(result.trustedIntroductions, 2);
  assert.deepEqual(x.controller.snapshot(), { consumedInvitations: 2, admittedPeers: 1 });
  const restarted = new PeerAdmissionController(x.config);
  assert.equal((await restarted.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers })).reason, 'subject-already-admitted');
  const another = createNodeIdentity();
  assert.equal((await restarted.admit({ subjectNodeId: another.nodeId, vouchers: x.vouchers })).reason, 'insufficient-valid-invitations');
});

test('capacity and storage pressure stop admission without consuming vouchers', async () => {
  const full = setup({ capacityProvider: async () => ({ activePeers: 10, maxPeers: 10, storageHeadroomRatio: 0.5 }) });
  assert.equal((await full.controller.admit({ subjectNodeId: full.subject.nodeId, vouchers: full.vouchers })).reason, 'peer-capacity-reached');
  const low = setup({ capacityProvider: async () => ({ activePeers: 1, maxPeers: 10, storageHeadroomRatio: 0.01 }) });
  assert.equal((await low.controller.admit({ subjectNodeId: low.subject.nodeId, vouchers: low.vouchers })).reason, 'storage-headroom-too-low');
  assert.deepEqual(low.controller.snapshot(), { consumedInvitations: 0, admittedPeers: 0 });
});

test('issuer quota limits future admissions without guilt-by-association penalties', async () => {
  const x = setup({ maxAdmissionsPerIssuer: 1 });
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers })).ok, true);
  const next = createNodeIdentity();
  const more = x.issuers.map(issuer => createPeerIntroductionVoucher({
    issuerIdentity: issuer, subjectNodeId: next.nodeId,
  }));
  assert.equal((await x.controller.admit({ subjectNodeId: next.nodeId, vouchers: more })).reason, 'issuer-admission-quota-reached');
});

test('serializes concurrent admissions for the same subject and fails closed on malformed state', async () => {
  const x = setup();
  const outcomes = await Promise.all([
    x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers }),
    x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers }),
  ]);
  assert.equal(outcomes.filter(r => r.ok).length, 1);
  assert.equal(outcomes.filter(r => r.reason === 'subject-already-admitted').length, 1);
  assert.throws(() => new PeerAdmissionController({ ...x.config, stateStore: { load: () => ({ version: 1, consumed: 'bad', admissions: [] }), save() {} } }), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
});

test('rejects asynchronous stores instead of acknowledging unconfirmed persistence', async () => {
  const x = setup();
  assert.throws(() => new PeerAdmissionController({
    ...x.config,
    stateStore: { load: async () => null, save() {} },
  }), { code: 'ZION_ADMISSION_ASYNC_STORE_UNSUPPORTED' });

  const state = { value: null };
  const controller = new PeerAdmissionController({
    ...x.config,
    stateStore: {
      load: () => state.value,
      save: async next => { state.value = structuredClone(next); },
    },
  });
  await assert.rejects(
    controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers }),
    { code: 'ZION_ADMISSION_ASYNC_STORE_UNSUPPORTED' },
  );
  assert.equal(controller.snapshot().admittedPeers, 0);
});
