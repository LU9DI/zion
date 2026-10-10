import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { EncryptedChunkStore } from '../src/crypto-store.js';

test('encrypted chunks round-trip and do not store plaintext', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  try {
    const store = new EncryptedChunkStore(root, randomBytes(32)); await store.init();
    const secret = Buffer.from('owner private content'); const ref = await store.put(secret);
    const stored = await readFile(store.chunkPath(ref.id));
    assert.equal(stored.includes(secret), false);
    assert.deepEqual(await store.get(ref.id), secret);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('modified ciphertext is rejected by content hash check', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  try {
    const store = new EncryptedChunkStore(root, randomBytes(32)); await store.init();
    const ref = await store.put('integrity'); const p = store.chunkPath(ref.id);
    const bytes = await readFile(p); bytes[bytes.length - 1] ^= 1; await writeFile(p, bytes);
    await assert.rejects(store.get(ref.id), /integrity check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects keys of wrong length', () => assert.throws(() => new EncryptedChunkStore('/tmp/x', Buffer.alloc(5)), /32 bytes/));

test('rejects chunks over the configured size ceiling before writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  try {
    const store = new EncryptedChunkStore(root, randomBytes(32), { maxChunkBytes: 8, maxStorageBytes: 1024 });
    await store.init();
    await assert.rejects(store.put(Buffer.alloc(9)), /maximum chunk size/);
    assert.equal(await store.sizeBytes(), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('enforces total storage quota even for concurrent writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  try {
    const store = new EncryptedChunkStore(root, randomBytes(32), { maxChunkBytes: 100, maxStorageBytes: 140 });
    await store.init();
    const outcomes = await Promise.allSettled([store.put(Buffer.alloc(80, 1)), store.put(Buffer.alloc(80, 2))]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    assert.ok(await store.sizeBytes() <= 140);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects invalid storage quota configuration', () => {
  assert.throws(() => new EncryptedChunkStore('/tmp/x', randomBytes(32), { maxChunkBytes: 1024, maxStorageBytes: 100 }), /fit at least one/);
});



test('refuses a storage root that is a symbolic link', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  const actual = path.join(parent, 'actual');
  const alias = path.join(parent, 'alias');
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(actual));
    await import('node:fs/promises').then(fs => fs.symlink(actual, alias, 'dir'));
    const store = new EncryptedChunkStore(alias, randomBytes(32));
    await assert.rejects(store.init(), /real directory/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('refuses symbolic links inside the storage tree when calculating quota', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  const outside = path.join(root, '..', `rea-outside-${randomBytes(6).toString('hex')}`);
  try {
    const store = new EncryptedChunkStore(root, randomBytes(32)); await store.init();
    await writeFile(outside, Buffer.alloc(8));
    const fs = await import('node:fs/promises');
    await fs.symlink(outside, path.join(root, 'outside-link'));
    await assert.rejects(store.sizeBytes(), /Symbolic links are not allowed/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test('writes chunk files atomically and keeps private file permissions where supported', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  try {
    const store = new EncryptedChunkStore(root, randomBytes(32)); await store.init();
    const ref = await store.put('atomic write');
    const fs = await import('node:fs/promises');
    const info = await fs.lstat(store.chunkPath(ref.id));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0);
    assert.deepEqual(await store.get(ref.id), Buffer.from('atomic write'));
    assert.equal((await fs.readdir(path.dirname(store.chunkPath(ref.id)))).some(name => name.startsWith('.tmp-')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('enforces storage quota across separate store instances sharing one directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  try {
    const options = { maxChunkBytes: 100, maxStorageBytes: 140 };
    const storeA = new EncryptedChunkStore(root, randomBytes(32), options);
    const storeB = new EncryptedChunkStore(root, randomBytes(32), options);
    await storeA.init(); await storeB.init();
    const outcomes = await Promise.allSettled([
      storeA.put(Buffer.alloc(80, 0x41)),
      storeB.put(Buffer.alloc(80, 0x42)),
    ]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
    assert.ok(await storeA.sizeBytes() <= options.maxStorageBytes);
    const fs = await import('node:fs/promises');
    await assert.rejects(fs.lstat(path.join(root, '.rea-write-lock')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('serializes quota checks between actual Node.js processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-test-'));
  const run = promisify(execFile);
  const script = `import { randomBytes } from 'node:crypto';
    import { EncryptedChunkStore } from ${JSON.stringify(new URL('../src/crypto-store.js', import.meta.url).href)};
    const store = new EncryptedChunkStore(process.argv[1], randomBytes(32), { maxChunkBytes: 100, maxStorageBytes: 140 });
    await store.init();
    try { await store.put(Buffer.alloc(80, Number(process.argv[2]))); process.stdout.write('ok'); }
    catch (error) { if (error instanceof RangeError) process.stdout.write('quota'); else throw error; }`;
  try {
    const results = await Promise.all([0x51, 0x52].map(value => run(process.execPath, ['--input-type=module', '-e', script, root, String(value)], { timeout: 15000 })));
    assert.deepEqual(results.map(result => result.stdout).sort(), ['ok', 'quota']);
    const store = new EncryptedChunkStore(root, randomBytes(32), { maxChunkBytes: 100, maxStorageBytes: 140 });
    await store.init();
    assert.ok(await store.sizeBytes() <= 140);
  } finally { await rm(root, { recursive: true, force: true }); }
});
