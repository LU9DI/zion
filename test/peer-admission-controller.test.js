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
  assert.throws(() => new PeerAdmissionController({
    ...x.config,
    stateStore: { load: () => ({
      version: 1,
      consumed: ['a'.repeat(64) + ':' + 'b'.repeat(32), 'a'.repeat(64) + ':' + 'b'.repeat(32)],
      admissions: [],
    }), save() {} },
  }), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
  assert.throws(() => new PeerAdmissionController({
    ...x.config,
    stateStore: { load: () => ({
      version: 1, consumed: [],
      admissions: [
        { subjectNodeId: 'a'.repeat(64), issuerNodeIds: ['b'.repeat(64)] },
        { subjectNodeId: 'a'.repeat(64), issuerNodeIds: ['c'.repeat(64)] },
      ],
    }), save() {} },
  }), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
});

test('awaits asynchronous persistence before reporting admission success', async () => {
  const x = setup();
  assert.throws(() => new PeerAdmissionController({
    ...x.config,
    stateStore: { load: async () => null, save() {} },
  }), { code: 'ZION_ADMISSION_ASYNC_STORE_UNSUPPORTED' });

  let persisted = null;
  let releaseSave;
  const delayedStore = {
    load: () => null,
    save: async next => {
      await new Promise(resolve => { releaseSave = resolve; });
      persisted = structuredClone(next);
    },
  };
  const controller = new PeerAdmissionController({ ...x.config, stateStore: delayedStore });
  const admission = controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.isAdmitted(x.subject.nodeId), false);
  assert.equal(persisted, null);
  releaseSave();
  assert.equal((await admission).ok, true);
  assert.equal(controller.isAdmitted(x.subject.nodeId), true);
  assert.equal(persisted.admissions.length, 1);
});

test('fails closed after uncertain persistence and requires restart to reconcile state', async () => {
  const x = setup();
  let saveCalls = 0;
  const controller = new PeerAdmissionController({
    ...x.config,
    stateStore: {
      load: () => null,
      save: async () => { saveCalls += 1; throw new Error('directory fsync failed after commit'); },
    },
  });
  await assert.rejects(controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers }), /directory fsync failed after commit/);
  assert.equal(controller.isAdmitted(x.subject.nodeId), false);
  assert.deepEqual(controller.snapshot(), { consumedInvitations: 0, admittedPeers: 0 });
  assert.deepEqual(
    await controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers }),
    { ok: false, reason: 'admission-state-unavailable' },
  );
  assert.equal(saveCalls, 1);
});


test('releaseAdmission persists revocation, preserves consumed vouchers, and serializes with admission', async () => {
  const x = setup();
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers })).ok, true);
  assert.equal(x.controller.isAdmitted(x.subject.nodeId), true);
  const released = await x.controller.releaseAdmission(x.subject.nodeId, 'revoked');
  assert.deepEqual(released, { ok: true, released: true, subjectNodeId: x.subject.nodeId, status: 'revoked' });
  assert.equal(x.controller.isAdmitted(x.subject.nodeId), false);
  assert.deepEqual(x.controller.snapshot(), { consumedInvitations: x.vouchers.length, admittedPeers: 0 });
  const restarted = new PeerAdmissionController(x.config);
  assert.equal(restarted.isAdmitted(x.subject.nodeId), false);
  assert.deepEqual(await restarted.releaseAdmission(x.subject.nodeId), {
    ok: true, released: false, subjectNodeId: x.subject.nodeId,
  });
});

test('releaseAdmission fails closed after uncertain persistence', async () => {
  const x = setup();
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers })).ok, true);
  const controller = new PeerAdmissionController({
    ...x.config,
    stateStore: {
      load: () => ({ version: 1, consumed: x.vouchers.map(v => `${v.issuerNodeId}:${v.nonce}`), admissions: [{
        subjectNodeId: x.subject.nodeId, issuerNodeIds: x.vouchers.map(v => v.issuerNodeId),
      }] }),
      save: async () => { throw new Error('release persistence uncertain'); },
    },
  });
  await assert.rejects(controller.releaseAdmission(x.subject.nodeId, 'revoked'), /release persistence uncertain/);
  assert.equal(controller.isAdmitted(x.subject.nodeId), false);
  assert.deepEqual(await controller.releaseAdmission(x.subject.nodeId, 'revoked'), {
    ok: false, reason: 'admission-state-unavailable',
  });
});
