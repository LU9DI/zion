import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RustStorageAdapter } from '../src/rust-storage-adapter.js';
import { PeerStorageService } from '../src/peer-storage-service.js';
import { createNodeIdentity } from '../src/peer-security.js';
import { createStoreRequest } from '../src/replication-receipts.js';

const binaryPath = process.env.ZION_RUST_STORAGE_BIN;

test('real Rust sidecar stores peer uploads through PeerStorageService and enforces quota', {
  skip: !binaryPath ? 'set ZION_RUST_STORAGE_BIN to the built rea-storage-cli binary' : false,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zion-rust-sidecar-integration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = Buffer.concat([Buffer.from('REAC1'), randomBytes(28)]);
  const second = Buffer.concat([Buffer.from('REAC1'), randomBytes(28)]);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const quota = first.length;
  const adapter = new RustStorageAdapter({
    binaryPath, root, maxChunkBytes: 1024, maxStorageBytes: quota, timeoutMs: 10_000,
  });

  await adapter.init();
  const targetIdentity = createNodeIdentity();
  const clientIdentity = createNodeIdentity();
  const service = new PeerStorageService({
    identity: targetIdentity, store: adapter, maxChunkBytes: 1024, partBytes: 1024,
  });
  const messages = [];
  const transport = { send(_socket, payload) { messages.push(payload); } };
  const request = createStoreRequest({
    chunkId: digest(first), bytes: first.length, targetNodeId: targetIdentity.nodeId,
  });
  await service.handle({ nodeId: clientIdentity.nodeId, payload: {
    type: 'STORE_CHUNK',
    transferId: randomBytes(16).toString('hex'),
    chunkId: digest(first),
    totalBytes: first.length,
    partIndex: 0,
    partCount: 1,
    data: first.toString('base64'),
    request,
  } }, {}, transport);

  assert.equal(messages.some(message => message.type === 'STORE_RECEIPT'), true);
  assert.deepEqual(await adapter.get(digest(first)), first);
  assert.deepEqual(await adapter.usage(), { usedBytes: first.length, quotaBytes: quota });

  await assert.rejects(
    adapter.put(digest(second), second),
    error => error?.code === 'CAPACITY_EXHAUSTED',
  );
  assert.deepEqual(await adapter.get(digest(first)), first, 'quota failure must preserve existing content');
  assert.deepEqual(await adapter.usage(), { usedBytes: first.length, quotaBytes: quota });
});
