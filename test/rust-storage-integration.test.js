import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RustStorageAdapter } from '../src/rust-storage-adapter.js';

const binaryPath = process.env.ZION_RUST_STORAGE_BIN;

test('real Rust sidecar interoperates with Node adapter for init, put, get, usage and quota errors', {
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
  const receipt = await adapter.put(digest(first), first);
  assert.deepEqual(receipt, { chunkId: digest(first), bytes: first.length, alreadyPresent: false });
  assert.deepEqual(await adapter.get(digest(first)), first);
  assert.deepEqual(await adapter.usage(), { usedBytes: first.length, quotaBytes: quota });

  await assert.rejects(
    adapter.put(digest(second), second),
    error => error?.code === 'CAPACITY_EXHAUSTED',
  );
  assert.deepEqual(await adapter.get(digest(first)), first, 'quota failure must preserve existing content');
  assert.deepEqual(await adapter.usage(), { usedBytes: first.length, quotaBytes: quota });
});
