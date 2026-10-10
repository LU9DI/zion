import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { RustStorageAdapter, RustStorageError } from '../src/rust-storage-adapter.js';

function fakeSpawn({ code = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const spawn = (binary, args, options) => {
    calls.push({ binary, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.write(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      if (stderr) child.stderr.write(stderr);
      child.stdout.end(); child.stderr.end(); child.stdin.resume();
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

const config = (spawn) => new RustStorageAdapter({
  binaryPath: './rea-storage-cli', root: './test-data', maxChunkBytes: 4096,
  maxStorageBytes: 16384, timeoutMs: 1000, spawn,
});

test('Rust adapter passes owner-controlled quota as local CLI arguments', async () => {
  const fake = fakeSpawn({ stdout: 'OK\n' });
  await config(fake.spawn).init();
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args.slice(0, 1), ['init']);
  assert.equal(fake.calls[0].args[2], '4096');
  assert.equal(fake.calls[0].args[3], '16384');
});

test('Rust adapter validates content address before invoking the sidecar', async () => {
  const fake = fakeSpawn({ stdout: 'OK 69 0\n' });
  const adapter = config(fake.spawn);
  await assert.rejects(() => adapter.put('../bad', Buffer.alloc(69)), /SHA-256/);
  assert.equal(fake.calls.length, 0);
  const envelope = Buffer.concat([Buffer.from('REAC1'), Buffer.alloc(64)]);
  const id = createHash('sha256').update(envelope).digest('hex');
  const receipt = await adapter.put(id, envelope);
  assert.deepEqual(receipt, { chunkId: id, bytes: 69, alreadyPresent: false });
  assert.equal(fake.calls[0].args.at(-1), id);
});

test('Rust adapter maps quota rejection to a typed error', async () => {
  const fake = fakeSpawn({ code: 2, stderr: 'ERR CAPACITY_EXHAUSTED 12\n' });
  const envelope = Buffer.concat([Buffer.from('REAC1'), Buffer.alloc(64)]);
  const id = createHash('sha256').update(envelope).digest('hex');
  await assert.rejects(() => config(fake.spawn).put(id, envelope), error => {
    assert.ok(error instanceof RustStorageError);
    assert.equal(error.code, 'CAPACITY_EXHAUSTED');
    assert.equal(error.availableBytes, 12);
    return true;
  });
});

test('Rust adapter returns bounded opaque bytes from get', async () => {
  const envelope = Buffer.concat([Buffer.from('REAC1'), Buffer.alloc(64)]);
  const fake = fakeSpawn({ stdout: envelope });
  const id = createHash('sha256').update(envelope).digest('hex');
  assert.deepEqual(await config(fake.spawn).get(id), envelope);
});

test('Rust adapter validates usage output', async () => {
  const fake = fakeSpawn({ stdout: '123\n' });
  assert.deepEqual(await config(fake.spawn).usage(), { usedBytes: 123, quotaBytes: 16384 });
  const bad = fakeSpawn({ stdout: 'NaN\n' });
  await assert.rejects(() => config(bad.spawn).usage(), error => error.code === 'INVALID_RESPONSE');
});

test('Rust adapter rejects invalid local configuration', () => {
  assert.throws(() => new RustStorageAdapter({ binaryPath: '', root: '/tmp/x', maxChunkBytes: 100, maxStorageBytes: 100 }), /binaryPath/);
  assert.throws(() => new RustStorageAdapter({ binaryPath: '/tmp/x', root: '/tmp/x', maxChunkBytes: 10, maxStorageBytes: 100 }), /maxChunkBytes/);
});

test('Rust adapter verifies returned envelope digest independently', async () => {
  const envelope = Buffer.concat([Buffer.from('REAC1'), Buffer.alloc(64, 2)]);
  const otherId = 'a'.repeat(64);
  const fake = fakeSpawn({ stdout: envelope });
  await assert.rejects(() => config(fake.spawn).get(otherId), error => error.code === 'DIGEST_MISMATCH');
});


test('Rust adapter kills a sidecar that exceeds its operation deadline', async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = signal => { killed = signal === 'SIGKILL'; };
    return child;
  };
  const adapter = new RustStorageAdapter({
    binaryPath: './rea-storage-cli', root: './test-data', maxChunkBytes: 4096,
    maxStorageBytes: 16384, timeoutMs: 100, spawn,
  });
  await assert.rejects(() => adapter.init(), error => error.code === 'SIDECAR_TIMEOUT');
  assert.equal(killed, true);
});

test('Rust adapter rejects oversized sidecar output and kills the child', async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = signal => { killed = signal === 'SIGKILL'; };
    queueMicrotask(() => child.stdout.write(Buffer.alloc(4097, 1)));
    return child;
  };
  const adapter = config(spawn);
  await assert.rejects(() => adapter.get('a'.repeat(64)), error => error.code === 'SIDECAR_OUTPUT_LIMIT');
  assert.equal(killed, true);
});
