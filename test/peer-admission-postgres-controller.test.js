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
    async withAdmissionFence(nodeId, work) {
      calls.push(['fence', nodeId]);
      if (state.get(nodeId) !== 'active') return { ok: true, admitted: false, status: state.get(nodeId) ?? null };
      return { ok: true, admitted: true, status: 'active', value: await work() };
    },
    async withPeerAuthorizationFence(nodeId, { allowUnadmitted = false } = {}, work) {
      calls.push(['peer-fence', nodeId, allowUnadmitted]);
      const status = state.get(nodeId) ?? null;
      if (status !== 'active' && !(status === null && allowUnadmitted)) {
        return { ok: true, admitted: false, status };
      }
      return { ok: true, admitted: true, status: status ?? 'trusted-allowlist', value: await work() };
    },
    async revokeAdmission(nodeId) {
      calls.push(['revoke', nodeId]);
      if (state.get(nodeId) !== 'active') return { ok: false, reason: 'admission-not-found' };
      state.set(nodeId, 'revoked');
      return { ok: true, changed: true, status: 'revoked' };
    },
    async releaseAdmission(nodeId, status = 'released') {
      calls.push(['release', nodeId, status]);
      if (state.get(nodeId) !== 'active') return { ok: true, changed: false, status: state.get(nodeId) ?? null };
      state.set(nodeId, status);
      return { ok: true, changed: true, subjectNodeId: nodeId, status };
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


test('Postgres controller delegates the final application dispatch fence to its store', async () => {
  const x = fixture();
  await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers });
  const result = await x.controller.withAdmissionFence(x.subject.nodeId, async () => 'dispatched');
  assert.deepEqual(result, {
    ok: true, admitted: true, status: 'active', value: 'dispatched',
  });
  assert.equal(x.store.calls.some(call => call[0] === 'fence'), true);
  await x.controller.revoke(x.subject.nodeId);
  assert.deepEqual(await x.controller.withAdmissionFence(x.subject.nodeId, async () => {
    throw new Error('revoked peer cannot dispatch');
  }), { ok: true, admitted: false, status: 'revoked' });
});


test('Postgres controller delegates trusted allowlist authorization with explicit no-row policy', async () => {
  const x = fixture();
  const result = await x.controller.withPeerAuthorizationFence(id('f'), { allowUnadmitted: true }, async () => 'trusted');
  assert.deepEqual(result, {
    ok: true, admitted: true, status: 'trusted-allowlist', value: 'trusted',
  });
  assert.ok(x.store.calls.some(call => call[0] === 'peer-fence' && call[1] === id('f') && call[2] === true));
});

test('Postgres controller exposes administrative release through the store fence', async () => {
  const x = fixture();
  await x.controller.admit({ subjectNodeId: x.subject.nodeId, vouchers: x.vouchers });
  const result = await x.controller.release(x.subject.nodeId);
  assert.deepEqual(result, {
    ok: true, changed: true, subjectNodeId: x.subject.nodeId, status: 'released',
  });
  assert.equal(await x.controller.isAdmitted(x.subject.nodeId), false);
  assert.deepEqual(await x.controller.withAdmissionFence(x.subject.nodeId, async () => {
    throw new Error('released peer cannot dispatch');
  }), { ok: true, admitted: false, status: 'released' });
  assert.equal(x.store.calls.some(call => call[0] === 'release' && call[2] === 'released'), true);
});
