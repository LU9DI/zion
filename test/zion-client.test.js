import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ZionClient, MemoryCiphertextAdapter } from '../src/zion-client.js';
import { createNodeIdentity } from '../src/peer-security.js';
import { createStoreRequest, createStoreReceipt } from '../src/replication-receipts.js';

const digest = data => createHash('sha256').update(data).digest('hex');

test('consumer client uploads encrypted chunks and round-trips without adapter seeing plaintext', async () => {
  const adapter = new MemoryCiphertextAdapter();
  const client = new ZionClient({ storageAdapter: adapter, chunkBytes: 4 });
  const plaintext = Buffer.from('private consumer data');
  const result = await client.upload(plaintext);
  assert.equal(result.screening.accepted, true);
  assert.equal(result.privacy, 'plaintext-and-file-key-remain-client-side');
  assert.equal(adapter.size, Math.ceil(plaintext.length / 4));
  for (const entry of result.manifest.chunks) {
    const stored = await adapter.getChunk(entry.id);
    assert.equal(stored.includes(plaintext), false);
    assert.equal(digest(stored), entry.id);
  }
  assert.deepEqual(await client.download({ cid: result.cid, manifest: result.manifest, fileKey: result.fileKey }), plaintext);
});

test('client rejects blacklist match before making any adapter calls', async () => {
  let calls = 0;
  const adapter = { async putChunk() { calls++; }, async getChunk() { calls++; } };
  const bad = Buffer.from('listed content');
  const client = new ZionClient({ storageAdapter: adapter, blacklistSha256: [digest(bad)] });
  await assert.rejects(client.upload(bad), error => error.code === 'ZION_CONTENT_REJECTED' && error.reason === 'blacklisted-hash');
  assert.equal(calls, 0);
});

test('manifest CID commits to nested chunk metadata and rejects tampering', async () => {
  const client = new ZionClient({ storageAdapter: new MemoryCiphertextAdapter(), chunkBytes: 3 });
  const result = await client.upload('abcdef');
  const changed = { ...result.manifest, chunks: result.manifest.chunks.map((c, i) => i ? c : { ...c, id: '0'.repeat(64) }) };
  await assert.rejects(client.download({ cid: result.cid, manifest: changed, fileKey: result.fileKey }), /manifest-cid-mismatch/);
});

test('download refuses corrupted ciphertext and wrong file key', async () => {
  const adapter = new MemoryCiphertextAdapter();
  const client = new ZionClient({ storageAdapter: adapter, chunkBytes: 64 });
  const result = await client.upload('secret');
  await assert.rejects(client.download({ manifest: result.manifest, fileKey: Buffer.alloc(32).toString('base64') }));
  const original = await adapter.getChunk(result.manifest.chunks[0].id);
  original[original.length - 1] ^= 1;
  // Inject a malicious adapter response without mutating the content-addressed test adapter.
  const corrupt = { async putChunk() {}, async getChunk() { return original; } };
  const corruptClient = new ZionClient({ storageAdapter: corrupt });
  await assert.rejects(corruptClient.download({ manifest: result.manifest, fileKey: result.fileKey }), /ciphertext-integrity-failed/);
});

test('empty files are supported and bounded', async () => {
  const client = new ZionClient({ storageAdapter: new MemoryCiphertextAdapter(), chunkBytes: 8, maxFileBytes: 8 });
  const result = await client.upload(Buffer.alloc(0));
  assert.equal(result.manifest.chunkCount, 1);
  assert.deepEqual(await client.download({ manifest: result.manifest, fileKey: result.fileKey }), Buffer.alloc(0));
  await assert.rejects(client.upload(Buffer.alloc(9)), error => error.code === 'ZION_FILE_SIZE_LIMIT');
});

test('download refuses gateway-blocked pointers', async () => {
  const registry = { isBlocked: cid => cid === 'blocked' };
  const client = new ZionClient({ storageAdapter: new MemoryCiphertextAdapter(), moderationRegistry: registry });
  const result = await client.upload('content');
  const blockedManifest = { ...result.manifest, cid: 'blocked' };
  // A blocked pointer cannot bypass manifest integrity checks by simply replacing its CID.
  await assert.rejects(client.download({ cid: 'blocked', manifest: blockedManifest, fileKey: result.fileKey }), /manifest-cid-mismatch/);
  const normal = await client.upload('other');
  const blockedRegistryClient = new ZionClient({ storageAdapter: { getChunk: async id => client.storageAdapter.getChunk(id), putChunk: async entry => client.storageAdapter.putChunk(entry) }, moderationRegistry: { isBlocked: () => true } });
  await assert.rejects(blockedRegistryClient.download({ manifest: normal.manifest, fileKey: normal.fileKey }), error => error.code === 'ZION_CONTENT_BLOCKED');
});

test('upload failure cleans up acknowledged chunks when adapter supports deletion', async () => {
  const memory = new MemoryCiphertextAdapter();
  let count = 0;
  const adapter = {
    putChunk: async value => { count++; if (count === 2) throw new Error('simulated-store-failure'); return memory.putChunk(value); },
    getChunk: id => memory.getChunk(id),
    rollbackChunk: id => memory.rollbackChunk(id),
  };
  const client = new ZionClient({ storageAdapter: adapter, chunkBytes: 2 });
  await assert.rejects(client.upload('abcdef'), /simulated-store-failure/);
  assert.equal(memory.size, 0);
});


test('SDK store alias exposes a stable application-facing entry point', async () => {
  const client = new ZionClient({ storageAdapter: new MemoryCiphertextAdapter(), chunkBytes: 5 });
  const stored = await client.store(Buffer.from('sdk API'));
  assert.equal(stored.cid, stored.manifest.cid);
  assert.equal(stored.screening.accepted, true);
  assert.deepEqual(await client.download({ manifest: stored.manifest, fileKey: stored.fileKey }), Buffer.from('sdk API'));
});


test('SDK verify method binds a receipt to its original storage request', () => {
  const identity = createNodeIdentity();
  const client = new ZionClient({ storageAdapter: new MemoryCiphertextAdapter() });
  const request = createStoreRequest({ chunkId: 'a'.repeat(64), bytes: 64, targetNodeId: identity.nodeId, now: 50_000 });
  const receipt = createStoreReceipt(identity, request, { storedBytes: 64, now: 50_001 });
  assert.equal(client.verify(receipt, request).ok, true);
  assert.equal(client.verify(receipt, { ...request, chunkId: 'b'.repeat(64) }).ok, false);
});
