import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createSignedManifest, verifySignedManifest } from '../src/signed-manifest.js';

const chunks = [
  { id: 'a'.repeat(64), bytes: 120 },
  { id: 'b'.repeat(64), bytes: 80 },
];

test('signed manifest verifies owner identity, chunk list, and total size', () => {
  const identity = createNodeIdentity();
  const manifest = createSignedManifest(identity, chunks, { createdAt: 1234 });
  assert.deepEqual(verifySignedManifest(manifest), { ok: true, ownerNodeId: identity.nodeId, totalBytes: 200, chunkCount: 2 });
});

test('signed manifest rejects tampered chunk descriptors and size', () => {
  const manifest = createSignedManifest(createNodeIdentity(), chunks, { createdAt: 1234 });
  assert.equal(verifySignedManifest({ ...manifest, totalBytes: 999 }).reason, 'size-mismatch');
  assert.equal(verifySignedManifest({ ...manifest, chunks: [{ ...chunks[0], bytes: 121 }, chunks[1]] }).reason, 'size-mismatch');
});

test('signed manifest rejects duplicate and malformed chunks', () => {
  const identity = createNodeIdentity();
  assert.throws(() => createSignedManifest(identity, [chunks[0], chunks[0]]), /Duplicate/);
  const manifest = createSignedManifest(identity, chunks, { createdAt: 1234 });
  assert.equal(verifySignedManifest({ ...manifest, chunks: [{ id: 'bad', bytes: 200 }, chunks[1]] }).reason, 'invalid-chunk');
});

test('signed manifest rejects signature tampering and identity substitution', () => {
  const manifest = createSignedManifest(createNodeIdentity(), chunks, { createdAt: 1234 });
  assert.equal(verifySignedManifest({ ...manifest, fileId: 'c'.repeat(64) }).reason, 'bad-signature');
  assert.equal(verifySignedManifest({ ...manifest, ownerNodeId: 'd'.repeat(64) }).reason, 'identity-mismatch');
});
