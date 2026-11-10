import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';
import { PostgresPeerAdmissionController } from '../src/peer-admission-postgres-controller.js';

const id = digit => digit.repeat(64);
function fixture() {
  const issuers = [createNodeIdentity(), createNodeIdentity(), createNodeIdentity()];
  const subject = createNodeIdentity();
  const vouchers = issuers.slice(0, 2).map(issuer =>
    createPeerIntroductionVoucher({ issuerIdentity: issuer, subjectNodeId: subject.nodeId }));
  const state = new Map();
  const calls = [];
  const store = {
    calls,
    async getAdmissionStatus(nodeId) {
      calls.push(['status', nodeId]);
      return { ok: true, status: state.get(nodeId) ?? null };
    },
    async commitAdmission(input) {
      calls.push(['admit', input]);
      if (state.has(input.subjectNodeId)) return { ok: false, reason: 'subject-already-admitted' };
      state.set(input.subjectNodeId, 'active');
      return { ok: true, subjectNodeId: input.subjectNodeId };
    },
    async revokeAdmission(nodeId) {
      calls.push(['revoke', nodeId]);
      if (state.get(nodeId) !== 'active') return { ok: false, reason: 'admission-not-found' };
      state.set(nodeId, 'revoked');
      return { ok: true, changed: true, status: 'revoked' };
    },
  };
  const controller = new PostgresPeerAdmissionController({
    store, trustedIssuerNodeIds: issuers.map(x => x.nodeId), threshold: 2,
    capacityProvider: async () => ({ activePeers: 1, maxPeers: 10, storageHeadroomRatio: 0.5 }),
  });
  return { controller, store, subject, vouchers };
}

test('Postgres controller checks authoritative status and denies revoked peers', async () => {
  const x = fixture();
  assert.equal(await x.controller.isAdmitted(x.subject.nodeId), false);
  assert.equal((await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers })).ok, true);
  assert.equal(await x.controller.isAdmitted(x.subject.nodeId), true);
  assert.equal((await x.controller.revoke(x.subject.nodeId)).changed, true);
  assert.equal(await x.controller.isAdmitted(x.subject.nodeId), false);
  assert.equal(x.store.calls.filter(call => call[0] === 'status').length, 3);
});

test('Postgres controller fails closed when authoritative status is unavailable', async () => {
  const x = fixture();
  x.store.getAdmissionStatus = async () => ({ ok: false, reason: 'admission-state-unavailable' });
  await assert.rejects(x.controller.isAdmitted(x.subject.nodeId), { code: 'ZION_ADMISSION_STATE_UNAVAILABLE' });
});

test('Postgres controller rejects duplicate issuer vouchers and does not persist insufficient introductions', async () => {
  const x = fixture();
  const result = await x.controller.admit({
    subjectNodeId: x.subject.nodeId, vouchers: [x.vouchers[0], x.vouchers[0]],
  });
  assert.deepEqual(result, { ok: false, reason: 'insufficient-valid-invitations' });
  assert.equal(x.store.calls.some(call => call[0] === 'admit'), false);
});

test('Postgres controller rejects malformed subject IDs before database writes', async () => {
  const x = fixture();
  assert.deepEqual(await x.controller.admit({ subjectNodeId: id('z'), vouchers: x.vouchers }), {
    ok: false, reason: 'invalid-input',
  });
  assert.equal(x.store.calls.length, 0);
});
