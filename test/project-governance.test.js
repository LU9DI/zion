import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import {
  createProjectGovernanceState,
  createGovernanceProposal,
  approveGovernanceProposal,
  applyGovernanceCertificate,
  verifyProjectGovernanceState,
} from '../src/project-governance.js';

const PROJECT = 'b'.repeat(64);
const NOW = 1_800_000_000_000;
function setup(threshold = 2) {
  const identities = Array.from({ length: 4 }, () => createNodeIdentity());
  const state = createProjectGovernanceState({
    projectId: PROJECT,
    governors: identities.slice(0, 3).map(({ nodeId, publicKeyPem }) => ({ nodeId, publicKeyPem })),
    threshold,
  });
  return { identities, state };
}
function approvals(identities, proposal) {
  return identities.map(identity => approveGovernanceProposal(identity, proposal, { now: NOW }));
}
function commit(state, proposal, signers) {
  return applyGovernanceCertificate(state, { proposal, approvals: approvals(signers, proposal) }, { now: NOW });
}

test('project governance adds a governor only after threshold approvals', () => {
  const { identities, state } = setup();
  const proposal = createGovernanceProposal(state, {
    action: 'ADD_GOVERNOR', nodeId: identities[3].nodeId, publicKeyPem: identities[3].publicKeyPem,
  });
  const next = commit(state, proposal, identities.slice(0, 2));
  assert.equal(next.epoch, 1);
  assert.equal(Object.keys(next.governors).length, 4);
  assert.equal(next.governors[identities[3].nodeId], identities[3].publicKeyPem);
  assert.equal(verifyProjectGovernanceState(next).ok, true);
});

test('project governance rejects insufficient, duplicate and unauthorized approvals', () => {
  const { identities, state } = setup();
  const proposal = createGovernanceProposal(state, { action: 'SET_THRESHOLD', threshold: 3 });
  const one = approvals(identities.slice(0, 1), proposal);
  assert.throws(() => applyGovernanceCertificate(state, { proposal, approvals: one }, { now: NOW }), /threshold/);
  const duplicated = approvals(identities.slice(0, 1), proposal);
  assert.throws(() => applyGovernanceCertificate(state, { proposal, approvals: [...duplicated, ...duplicated] }, { now: NOW }), /duplicate/);
  const outsider = approvals([identities[3]], proposal);
  assert.throws(() => applyGovernanceCertificate(state, { proposal, approvals: outsider }, { now: NOW }), /unauthorized/);
});

test('project governance rejects stale epochs and certificates for another project', () => {
  const { identities, state } = setup();
  const proposal = createGovernanceProposal(state, { action: 'SET_THRESHOLD', threshold: 3 });
  const next = commit(state, proposal, identities.slice(0, 2));
  assert.throws(() => applyGovernanceCertificate(next, { proposal, approvals: approvals(identities.slice(0, 2), proposal) }, { now: NOW }), /stale/);
  const foreign = { ...proposal, projectId: 'c'.repeat(64) };
  assert.throws(() => applyGovernanceCertificate(state, { proposal: foreign, approvals: approvals(identities.slice(0, 2), foreign) }, { now: NOW }), /another project/);
});

test('project governance revokes a compromised identity after threshold approval', () => {
  const { identities, state } = setup();
  const proposal = createGovernanceProposal(state, { action: 'REVOKE_GOVERNOR', nodeId: identities[2].nodeId });
  const next = commit(state, proposal, identities.slice(0, 2));
  assert.equal(next.epoch, 1);
  assert.equal(Object.hasOwn(next.governors, identities[2].nodeId), false);
  assert.equal(Object.keys(next.governors).length, 2);
});

test('project governance rotates a key to its new cryptographic node identity', () => {
  const { identities, state } = setup();
  const replacement = createNodeIdentity();
  const proposal = createGovernanceProposal(state, {
    action: 'ROTATE_GOVERNOR_KEY',
    oldNodeId: identities[0].nodeId,
    nodeId: replacement.nodeId,
    publicKeyPem: replacement.publicKeyPem,
  });
  const next = commit(state, proposal, identities.slice(0, 2));
  assert.equal(Object.hasOwn(next.governors, identities[0].nodeId), false);
  assert.equal(next.governors[replacement.nodeId], replacement.publicKeyPem);
  assert.equal(Object.keys(next.governors).length, 3);
});

test('project governance refuses threshold-breaking revocation and malformed genesis', () => {
  const { identities } = setup(3);
  const state = createProjectGovernanceState({
    projectId: PROJECT,
    governors: identities.slice(0, 3).map(({ nodeId, publicKeyPem }) => ({ nodeId, publicKeyPem })),
    threshold: 3,
  });
  assert.throws(() => createGovernanceProposal(state, { action: 'REVOKE_GOVERNOR', nodeId: identities[2].nodeId }), /threshold/);
  assert.throws(() => createProjectGovernanceState({
    projectId: PROJECT, governors: [{ nodeId: identities[0].nodeId, publicKeyPem: identities[1].publicKeyPem }], threshold: 1,
  }), /does not match/);
});

test('project governance binds approvals to exact proposal contents', () => {
  const { identities, state } = setup();
  const proposal = createGovernanceProposal(state, { action: 'SET_THRESHOLD', threshold: 3 });
  const signed = approvals(identities.slice(0, 2), proposal);
  const altered = { ...proposal, threshold: 1 };
  assert.throws(() => applyGovernanceCertificate(state, { proposal: altered, approvals: signed }, { now: NOW }), /does not bind/);
});
