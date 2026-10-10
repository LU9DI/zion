import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';
import { PeerAdmissionController } from '../src/peer-admission-controller.js';
import { AdmissionRolloutPolicy } from '../src/admission-rollout-policy.js';

test('admission controller applies rollout cap without bypassing invite verification', async () => {
  const issuerA = createNodeIdentity();
  const issuerB = createNodeIdentity();
  const subject = createNodeIdentity();
  let activePeers = 24;
  const rolloutPolicy = new AdmissionRolloutPolicy({ stage: 'pilot' });
  const state = { value: null };
  const controller = new PeerAdmissionController({
    trustedIssuerNodeIds: [issuerA.nodeId, issuerB.nodeId],
    threshold: 2,
    maxActivePeers: 100,
    capacityProvider: async () => ({ activePeers, maxPeers: 100, storageHeadroomRatio: 0.5 }),
    stateStore: { load: () => state.value, save: value => { state.value = structuredClone(value); } },
    rolloutPolicy,
  });
  const vouchers = [
    createPeerIntroductionVoucher({ issuerIdentity: issuerA, subjectNodeId: subject.nodeId }),
    createPeerIntroductionVoucher({ issuerIdentity: issuerB, subjectNodeId: subject.nodeId }),
  ];
  activePeers = 25;
  assert.equal((await controller.admit({ subjectNodeId: subject.nodeId, vouchers })).reason, 'rollout-stage-cap-reached');
  assert.equal(controller.snapshot().admittedPeers, 0);
  rolloutPolicy.setStage('cohort');
  activePeers = 99;
  assert.equal((await controller.admit({ subjectNodeId: subject.nodeId, vouchers })).ok, true);
});
