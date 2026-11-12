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

test('required local malware scanner runs before encryption and storage', async () => {
  let scanned = 0;
  let stored = 0;
  const adapter = {
    async putChunk({ ciphertext }) { stored++; assert.equal(ciphertext.includes(Buffer.from('known-clean-fixture')), false); return { created: true }; },
    async getChunk() { throw new Error('not-used'); },
  };
  const client = new ZionClient({
    storageAdapter: adapter,
    requireMalwareScan: true,
    malwareScanner: {
      async scan({ content, sha256: contentHash, bytes }) {
        scanned++;
        assert.deepEqual(content, Buffer.from('known-clean-fixture'));
        assert.equal(contentHash, digest(content));
        assert.equal(bytes, content.length);
        return { verdict: 'clean' };
      },
    },
  });
  const result = await client.upload(Buffer.from('known-clean-fixture'));
  assert.equal(scanned, 1);
  assert.equal(stored, 1);
  assert.equal(result.screening.malwareScan, 'clean');
});

test('malware scanner rejects malicious, suspicious, and unknown verdicts before storage', async t => {
  for (const verdict of ['malicious', 'suspicious', 'unknown', undefined]) {
    await t.test(String(verdict), async () => {
      let calls = 0;
      const client = new ZionClient({
        storageAdapter: { async putChunk() { calls++; }, async getChunk() { calls++; } },
        malwareScanner: { async scan() { return verdict === undefined ? null : { verdict }; } },
      });
      await assert.rejects(client.upload(Buffer.from('blocked fixture')), error =>
        error.code === 'ZION_CONTENT_REJECTED' && error.reason.startsWith('malware-'));
      assert.equal(calls, 0);
    });
  }
});

test('malware scanner errors fail closed before storage', async () => {
  let calls = 0;
  const client = new ZionClient({
    storageAdapter: { async putChunk() { calls++; }, async getChunk() { calls++; } },
    malwareScanner: { async scan() { throw new Error('scanner unavailable'); } },
  });
  await assert.rejects(client.upload('fixture'), error => error.code === 'ZION_MALWARE_SCAN_FAILED');
  assert.equal(calls, 0);
});

test('production policy can require a local malware scanner at construction', () => {
  assert.throws(
    () => new ZionClient({ storageAdapter: new MemoryCiphertextAdapter(), requireMalwareScan: true }),
    error => error.code === 'ZION_MALWARE_SCANNER_REQUIRED',
  );
});

test('scanner receives a copy and cannot mutate the plaintext that Zion encrypts', async () => {
  const adapter = new MemoryCiphertextAdapter();
  const client = new ZionClient({
    storageAdapter: adapter,
    requireMalwareScan: true,
    malwareScanner: {
      async scan({ content }) { content.fill(0); return { verdict: 'clean' }; },
    },
  });
  const input = Buffer.from('original plaintext');
  const result = await client.upload(input);
  assert.deepEqual(await client.download({ manifest: result.manifest, fileKey: result.fileKey }), input);
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


test('malware scanner timeout aborts the scan and fails closed before storage', async () => {
  let stored = 0;
  let aborted = false;
  const client = new ZionClient({
    storageAdapter: { async putChunk() { stored++; }, async getChunk() { throw new Error('not-used'); } },
    malwareScanTimeoutMs: 10,
    malwareScanner: {
      scan({ signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(new Error('scanner-aborted')); }, { once: true });
        });
      },
    },
  });
  await assert.rejects(client.upload('timeout fixture'), error => error.code === 'ZION_MALWARE_SCAN_TIMEOUT');
  assert.equal(aborted, true);
  assert.equal(stored, 0);
});

test('malware scan timeout configuration is bounded', () => {
  for (const value of [0, -1, 300_001, 1.5, NaN]) {
    assert.throws(
      () => new ZionClient({ storageAdapter: new MemoryCiphertextAdapter(), malwareScanTimeoutMs: value }),
      /malwareScanTimeoutMs/,
    );
  }
});
