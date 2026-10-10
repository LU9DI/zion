import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { solveNodeProofOfWork, verifyNodeProofOfWork } from '../src/node-proof-of-work.js';

test('proof of work is bound to the existing public-key-derived node ID', async () => {
  const identity = createNodeIdentity();
  const proof = await solveNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, nodeId: identity.nodeId, difficultyBits: 8, maxAttempts: 100_000 });
  assert.equal(verifyNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, ...proof, expectedNodeId: identity.nodeId }), true);
  assert.equal(verifyNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, ...proof, expectedNodeId: 'f'.repeat(64) }), false);
  assert.equal(verifyNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, ...proof, difficultyBits: 28, expectedNodeId: identity.nodeId }), false);
});

test('proof of work validates bounds and supports cancellation', async () => {
  const identity = createNodeIdentity();
  await assert.rejects(solveNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, nodeId: identity.nodeId, difficultyBits: 29 }), /difficultyBits/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(solveNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, nodeId: identity.nodeId, difficultyBits: 28, signal: controller.signal }), /cancelled/);
  assert.equal(verifyNodeProofOfWork({ publicKeyPem: identity.publicKeyPem, nonce: '01', difficultyBits: 1, expectedNodeId: identity.nodeId }), false);
});
