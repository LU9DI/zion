import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNodeIdentity } from '../src/peer-security.js';
import {
  createFileKeyEnvelope, generateFileKeyRecipientIdentity, openFileKeyEnvelope,
} from '../src/file-key-sharing.js';

const cid = 'a'.repeat(64);

test('file key envelope encrypts to one recipient and survives offline verification', () => {
  const sender = createNodeIdentity();
  const recipient = generateFileKeyRecipientIdentity();
  const fileKey = randomBytes(32);
  const envelope = createFileKeyEnvelope(sender, recipient.publicKeyPem, { cid, fileKey, now: 1000 });
  const opened = openFileKeyEnvelope(envelope, recipient.privateKeyPem, { expectedCid: cid, expectedSenderNodeId: sender.nodeId });
  assert.deepEqual(opened.fileKey, fileKey);
  assert.equal(opened.cid, cid);
  assert.equal(opened.senderNodeId, sender.nodeId);
  opened.fileKey.fill(0);
  fileKey.fill(0);
});

test('file key envelope rejects another recipient and mismatched content identifiers', () => {
  const sender = createNodeIdentity();
  const recipient = generateFileKeyRecipientIdentity();
  const otherRecipient = generateFileKeyRecipientIdentity();
  const envelope = createFileKeyEnvelope(sender, recipient.publicKeyPem, { cid, fileKey: randomBytes(32), now: 2000 });
  assert.throws(() => openFileKeyEnvelope(envelope, otherRecipient.privateKeyPem), /targets another recipient/);
  assert.throws(() => openFileKeyEnvelope(envelope, recipient.privateKeyPem, { expectedCid: 'b'.repeat(64) }), /identifier mismatch/);
  assert.throws(() => openFileKeyEnvelope(envelope, recipient.privateKeyPem, { expectedSenderNodeId: otherRecipient.publicKeyPem }), /Unexpected key envelope sender/);
});

test('file key envelope rejects signature and ciphertext tampering', () => {
  const sender = createNodeIdentity();
  const recipient = generateFileKeyRecipientIdentity();
  const envelope = createFileKeyEnvelope(sender, recipient.publicKeyPem, { cid, fileKey: randomBytes(32), now: 3000 });
  assert.throws(() => openFileKeyEnvelope({ ...envelope, signature: 'invalid' }, recipient.privateKeyPem), /Invalid key envelope signature/);
  const changed = { ...envelope, payload: { ...envelope.payload, ciphertext: Buffer.alloc(32).toString('base64') } };
  assert.throws(() => openFileKeyEnvelope(changed, recipient.privateKeyPem), /Invalid key envelope signature/);
});

test('file key envelope validates key types, file key size and CID shape', () => {
  const sender = createNodeIdentity();
  const recipient = generateFileKeyRecipientIdentity();
  assert.throws(() => createFileKeyEnvelope(sender, recipient.publicKeyPem, { cid: 'not-a-cid', fileKey: randomBytes(32) }), /content identifier/);
  assert.throws(() => createFileKeyEnvelope(sender, recipient.publicKeyPem, { cid, fileKey: Buffer.alloc(31) }), /exactly 32 bytes/);
  assert.throws(() => createFileKeyEnvelope(sender, sender.publicKeyPem, { cid, fileKey: randomBytes(32) }), /X25519/);
});
