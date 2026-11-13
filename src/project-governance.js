import { createHash, createPublicKey } from 'node:crypto';
import { signPeerMessage, verifyPeerMessage } from './peer-security.js';

const HEX64 = /^[a-f0-9]{64}$/;
const APPROVAL_TYPE = 'PROJECT_GOVERNANCE_APPROVAL';
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Governance values must use safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('Unsupported governance value');
}
const digest = value => createHash('sha256').update('ZION-PROJECT-GOVERNANCE-V1\0').update(canonical(value)).digest('hex');
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(label + ' has missing or unknown fields');
}
function validatePublicKey(nodeId, publicKeyPem) {
  if (typeof nodeId !== 'string' || !HEX64.test(nodeId) || typeof publicKeyPem !== 'string' || publicKeyPem.length > 4096) throw new TypeError('Invalid governance public key');
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Governance keys must be Ed25519');
  const derived = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  if (derived !== nodeId) throw new TypeError('Governance key does not match its node ID');
  return publicKeyPem;
}
function freezeState(state) {
  const governors = Object.freeze(Object.fromEntries(Object.entries(state.governors).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  const value = { schemaVersion: 1, projectId: state.projectId, epoch: state.epoch, threshold: state.threshold, governors };
  return Object.freeze({ ...value, stateHash: digest(value) });
}
function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !HEX64.test(state.projectId || '') ||
      !Number.isSafeInteger(state.epoch) || state.epoch < 0 || state.epoch >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(state.threshold) || !state.governors ||
      typeof state.governors !== 'object' || Array.isArray(state.governors) ||
      (Object.getPrototypeOf(state.governors) !== Object.prototype && Object.getPrototypeOf(state.governors) !== null)) throw new TypeError('Invalid project governance state');
  exactKeys(state, state.stateHash === undefined ? ['schemaVersion', 'projectId', 'epoch', 'threshold', 'governors'] : ['schemaVersion', 'projectId', 'epoch', 'threshold', 'governors', 'stateHash'], 'Governance state');
  const entries = Object.entries(state.governors);
  if (!entries.length || entries.length > 256 || state.threshold < 1 || state.threshold > entries.length) throw new TypeError('Invalid project governance threshold or membership');
  for (const [nodeId, pem] of entries) validatePublicKey(nodeId, pem);
  const normalized = freezeState(state);
  if (state.stateHash !== undefined && state.stateHash !== normalized.stateHash) throw new TypeError('Project governance state hash mismatch');
  return normalized;
}
/** Construct the initial project governance trust anchor from the project's creation ceremony. */
export function createProjectGovernanceState({ projectId, governors, threshold }) {
  if (!HEX64.test(projectId || '') || !Array.isArray(governors) || governors.length < 1 || governors.length > 256 ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > governors.length) throw new TypeError('Invalid project governance genesis');
  const members = {};
  for (const governor of governors) {
    if (!governor || Object.hasOwn(members, governor.nodeId)) throw new TypeError('Duplicate or invalid governor');
    members[governor.nodeId] = validatePublicKey(governor.nodeId, governor.publicKeyPem);
  }
  return freezeState({ projectId, epoch: 0, threshold, governors: members });
}
export function createGovernanceProposal(stateInput, change) {
  const state = validateState(stateInput);
  if (state.epoch >= Number.MAX_SAFE_INTEGER - 1) throw new RangeError('Project governance epoch space exhausted');
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new TypeError('Invalid governance change');
  const base = { schemaVersion: 1, projectId: state.projectId, epoch: state.epoch + 1, previousStateHash: state.stateHash, action: change.action };
  let proposal;
  switch (change.action) {
    case 'ADD_GOVERNOR':
    case 'ROTATE_GOVERNOR_KEY':
      if (change.action === 'ADD_GOVERNOR') {
        exactKeys(change, ['action', 'nodeId', 'publicKeyPem'], 'Governance change');
        proposal = { ...base, nodeId: change.nodeId, publicKeyPem: change.publicKeyPem };
        validatePublicKey(proposal.nodeId, proposal.publicKeyPem);
        if (Object.hasOwn(state.governors, change.nodeId)) throw new Error('Governor already exists');
      } else {
        exactKeys(change, ['action', 'oldNodeId', 'nodeId', 'publicKeyPem'], 'Governance change');
        proposal = { ...base, oldNodeId: change.oldNodeId, nodeId: change.nodeId, publicKeyPem: change.publicKeyPem };
        validatePublicKey(proposal.nodeId, proposal.publicKeyPem);
        if (!Object.hasOwn(state.governors, change.oldNodeId)) throw new Error('Governor to rotate does not exist');
        if (Object.hasOwn(state.governors, change.nodeId) || Object.values(state.governors).includes(change.publicKeyPem)) throw new Error('Rotated governance identity is already assigned');
      }
      break;
    case 'REVOKE_GOVERNOR':
      exactKeys(change, ['action', 'nodeId'], 'Governance change');
      if (!Object.hasOwn(state.governors, change.nodeId)) throw new Error('Governor to revoke does not exist');
      if (Object.keys(state.governors).length - 1 < state.threshold) throw new Error('Revocation would violate threshold; lower it in a separate committed epoch first');
      proposal = { ...base, nodeId: change.nodeId };
      break;
    case 'SET_THRESHOLD':
      exactKeys(change, ['action', 'threshold'], 'Governance change');
      if (!Number.isSafeInteger(change.threshold) || change.threshold < 1 || change.threshold > Object.keys(state.governors).length) throw new TypeError('Invalid new governance threshold');
      proposal = { ...base, threshold: change.threshold };
      break;
    default: throw new TypeError('Unsupported governance action');
  }
  return Object.freeze(proposal);
}
/** Each active governor signs the same proposal; these signatures alone are not a consensus certificate. */
export function approveGovernanceProposal(identity, proposal, { now = Date.now() } = {}) {
  if (!identity || !identity.privateKey || !HEX64.test(identity.nodeId || '') ||
      !proposal || !HEX64.test(proposal.projectId || '') || !HEX64.test(proposal.previousStateHash || '') ||
      !Number.isSafeInteger(proposal.epoch) || proposal.epoch < 1) throw new TypeError('Invalid governance approval input');
  return signPeerMessage(identity, { type: APPROVAL_TYPE, projectId: proposal.projectId, epoch: proposal.epoch, proposalHash: digest(proposal) }, { now });
}

/** Proof that a proposed new governor controls the private key for its node ID. */
export function proveGovernanceKeyPossession(identity, proposal, { now = Date.now() } = {}) {
  if (!identity || !identity.privateKey || !HEX64.test(identity.nodeId || '') ||
      !proposal || !['ADD_GOVERNOR', 'ROTATE_GOVERNOR_KEY'].includes(proposal.action) ||
      proposal.nodeId !== identity.nodeId || !HEX64.test(proposal.projectId || '') ||
      !HEX64.test(proposal.previousStateHash || '') || !Number.isSafeInteger(proposal.epoch) || proposal.epoch < 1) {
    throw new TypeError('Invalid governance key-possession proof input');
  }
  validatePublicKey(identity.nodeId, identity.publicKeyPem);
  if (proposal.publicKeyPem !== identity.publicKeyPem) throw new Error('New governor identity does not match the proposed public key');
  const payload = {
    type: 'PROJECT_GOVERNANCE_KEY_POSSESSION',
    action: proposal.action,
    projectId: proposal.projectId,
    epoch: proposal.epoch,
    proposalHash: digest(proposal),
    newNodeId: proposal.nodeId,
  };
  if (proposal.action === 'ROTATE_GOVERNOR_KEY') payload.oldNodeId = proposal.oldNodeId;
  return signPeerMessage(identity, payload, { now });
}
function validateProposalShape(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) ||
      proposal.schemaVersion !== 1 || !HEX64.test(proposal.projectId || '') ||
      !Number.isSafeInteger(proposal.epoch) || proposal.epoch < 1 ||
      !HEX64.test(proposal.previousStateHash || '') || typeof proposal.action !== 'string') {
    throw new Error('Malformed governance proposal');
  }
  switch (proposal.action) {
    case 'ADD_GOVERNOR':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'nodeId', 'publicKeyPem'], 'Add-governor proposal');
      validatePublicKey(proposal.nodeId, proposal.publicKeyPem);
      break;
    case 'ROTATE_GOVERNOR_KEY':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'oldNodeId', 'nodeId', 'publicKeyPem'], 'Rotate-key proposal');
      if (!HEX64.test(proposal.oldNodeId || '')) throw new Error('Invalid old governor identity');
      validatePublicKey(proposal.nodeId, proposal.publicKeyPem);
      break;
    case 'REVOKE_GOVERNOR':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'nodeId'], 'Revoke-governor proposal');
      if (!HEX64.test(proposal.nodeId || '')) throw new Error('Invalid governor identity');
      break;
    case 'SET_THRESHOLD':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'threshold'], 'Set-threshold proposal');
      if (!Number.isSafeInteger(proposal.threshold) || proposal.threshold < 1 || proposal.threshold > 256) throw new Error('Invalid proposed threshold');
      break;
    default: throw new Error('Unsupported governance action');
  }
}
/** Verify threshold approval and deterministically apply one epoch. Caller must commit it through distributed BFT. */
export function applyGovernanceCertificate(stateInput, certificate, { now = Date.now(), maxClockSkewMs = 120000 } = {}) {
  const state = validateState(stateInput);
  if (state.epoch >= Number.MAX_SAFE_INTEGER - 1) throw new RangeError('Project governance epoch space exhausted');
  if (!certificate || typeof certificate !== 'object' || Array.isArray(certificate)) throw new TypeError('Governance certificate must be an object');
  const proposal = certificate.proposal;
  validateProposalShape(proposal);
  exactKeys(certificate, ['ADD_GOVERNOR', 'ROTATE_GOVERNOR_KEY'].includes(proposal.action)
    ? ['proposal', 'approvals', 'newIdentityProof']
    : ['proposal', 'approvals'], 'Governance certificate');
  if (proposal.projectId !== state.projectId ||
      proposal.epoch !== state.epoch + 1 || proposal.previousStateHash !== state.stateHash ||
      !Array.isArray(certificate.approvals) || certificate.approvals.length > 256) throw new Error('Governance proposal is stale, malformed, or for another project');
  const proposalHash = digest(proposal), signers = new Set();
  for (const approval of certificate.approvals) {
    exactKeys(approval, ['version', 'nodeId', 'timestamp', 'nonce', 'payload', 'publicKeyPem', 'signature'], 'Governance approval envelope');
    if (typeof approval.publicKeyPem !== 'string' || approval.publicKeyPem.length > 4096 ||
        typeof approval.signature !== 'string' || approval.signature.length > 256) throw new Error('Oversized governance approval envelope');
    exactKeys(approval.payload, ['type', 'projectId', 'epoch', 'proposalHash'], 'Governance approval payload');
    const checked = verifyPeerMessage(approval, { now, maxClockSkewMs, maxBytes: 4096 });
    if (!checked.ok || !Object.hasOwn(state.governors, checked.nodeId) || signers.has(checked.nodeId)) throw new Error('Invalid, unauthorized, or duplicate governance approval');
    const payload = checked.payload;
    if (payload.type !== APPROVAL_TYPE || payload.projectId !== state.projectId || payload.epoch !== proposal.epoch || payload.proposalHash !== proposalHash) throw new Error('Approval does not bind to this proposal');
    signers.add(checked.nodeId);
  }
  if (signers.size < state.threshold) throw new Error('Governance threshold not reached');
  if (['ADD_GOVERNOR', 'ROTATE_GOVERNOR_KEY'].includes(proposal.action)) {
    if (proposal.action === 'ROTATE_GOVERNOR_KEY' && !signers.has(proposal.oldNodeId)) {
      throw new Error('Key rotation requires approval from the outgoing governor identity');
    }
    const proof = certificate.newIdentityProof;
    const checkedProof = verifyPeerMessage(proof, { now, maxClockSkewMs, maxBytes: 4096 });
    if (!checkedProof.ok || checkedProof.nodeId !== proposal.nodeId) throw new Error('Invalid new governor proof of possession');
    const payload = checkedProof.payload;
    const expectedPayload = {
      type: 'PROJECT_GOVERNANCE_KEY_POSSESSION',
      action: proposal.action,
      projectId: state.projectId,
      epoch: proposal.epoch,
      proposalHash,
      newNodeId: proposal.nodeId,
    };
    if (proposal.action === 'ROTATE_GOVERNOR_KEY') expectedPayload.oldNodeId = proposal.oldNodeId;
    exactKeys(payload, Object.keys(expectedPayload), 'New governor proof payload');
    if (Object.keys(expectedPayload).some(key => payload[key] !== expectedPayload[key])) {
      throw new Error('New governor proof does not bind to this proposal');
    }
    if (proof.publicKeyPem !== proposal.publicKeyPem) throw new Error('New governor proof uses a different public key');
  }
  const next = { projectId: state.projectId, epoch: proposal.epoch, threshold: state.threshold, governors: { ...state.governors } };
  switch (proposal.action) {
    case 'ADD_GOVERNOR':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'nodeId', 'publicKeyPem'], 'Add-governor proposal');
      if (Object.hasOwn(next.governors, proposal.nodeId) || Object.keys(next.governors).length >= 256) throw new Error('Governor exists or membership is full');
      next.governors[proposal.nodeId] = validatePublicKey(proposal.nodeId, proposal.publicKeyPem);
      break;
    case 'ROTATE_GOVERNOR_KEY':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'oldNodeId', 'nodeId', 'publicKeyPem'], 'Rotate-key proposal');
      if (!Object.hasOwn(next.governors, proposal.oldNodeId) || Object.hasOwn(next.governors, proposal.nodeId)) throw new Error('Invalid identity rotation');
      validatePublicKey(proposal.nodeId, proposal.publicKeyPem);
      if (Object.values(next.governors).includes(proposal.publicKeyPem)) throw new Error('Rotated key is already assigned');
      delete next.governors[proposal.oldNodeId];
      next.governors[proposal.nodeId] = proposal.publicKeyPem;
      break;
    case 'REVOKE_GOVERNOR':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'nodeId'], 'Revoke-governor proposal');
      if (!Object.hasOwn(next.governors, proposal.nodeId) || Object.keys(next.governors).length - 1 < next.threshold) throw new Error('Invalid revocation or threshold would be violated');
      delete next.governors[proposal.nodeId];
      break;
    case 'SET_THRESHOLD':
      exactKeys(proposal, ['schemaVersion', 'projectId', 'epoch', 'previousStateHash', 'action', 'threshold'], 'Set-threshold proposal');
      if (!Number.isSafeInteger(proposal.threshold) || proposal.threshold < 1 || proposal.threshold > Object.keys(next.governors).length) throw new Error('Invalid new governance threshold');
      next.threshold = proposal.threshold;
      break;
    default: throw new Error('Unsupported governance action');
  }
  return freezeState(next);
}
export function verifyProjectGovernanceState(state) {
  try { return { ok: true, state: validateState(state) }; }
  catch (error) { return { ok: false, reason: error.message }; }
}
