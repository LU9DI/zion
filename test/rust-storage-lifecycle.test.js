import test from 'node:test';
import assert from 'node:assert/strict';
import { RustStorageLifecycle, rustStorageBootstrapHooks } from '../src/rust-storage-lifecycle.js';

function fakeAdapter({ init = async () => {}, put = async (id, bytes) => ({ chunkId: id, bytes: bytes.length }), get = async id => Buffer.from(id), usage = async () => ({ usedBytes: 0, quotaBytes: 100 }) } = {}) {
  return { init, put, get, usage };
}

test('storage lifecycle blocks operations before start and after stop', async () => {
  const lifecycle = new RustStorageLifecycle(fakeAdapter());
  await assert.rejects(lifecycle.get('abc'), error => error.code === 'ZION_STORAGE_NOT_RUNNING');
  assert.equal((await lifecycle.start()).running, true);
  assert.deepEqual(await lifecycle.get('abc'), Buffer.from('abc'));
  assert.equal((await lifecycle.stop()).state, 'stopped');
  await assert.rejects(lifecycle.usage(), error => error.code === 'ZION_STORAGE_NOT_RUNNING');
});

test('storage shutdown drains in-flight operations and rejects new operations', async () => {
  let finishPut;
  const adapter = fakeAdapter({ put: () => new Promise(resolve => { finishPut = resolve; }) });
  const lifecycle = new RustStorageLifecycle(adapter);
  await lifecycle.start();
  const pending = lifecycle.put('chunk', Buffer.from('ciphertext'));
  await new Promise(resolve => setImmediate(resolve));
  const stopping = lifecycle.stop();
  await assert.rejects(lifecycle.get('chunk'), error => error.code === 'ZION_STORAGE_NOT_RUNNING');
  assert.equal(lifecycle.getStatus().state, 'stopping');
  finishPut({ chunkId: 'chunk', bytes: 10 });
  await pending;
  assert.equal((await stopping).state, 'stopped');
  assert.equal(lifecycle.getStatus().activeOperations, 0);
});

test('storage startup failure is reported and a later retry can succeed', async () => {
  let calls = 0;
  const lifecycle = new RustStorageLifecycle(fakeAdapter({ init: async () => { calls++; if (calls === 1) throw new Error('init failed'); } }));
  await assert.rejects(lifecycle.start(), /init failed/);
  assert.equal(lifecycle.getStatus().running, false);
  assert.equal(lifecycle.getStatus().lastError, 'init failed');
  assert.equal((await lifecycle.start()).running, true);
  await lifecycle.stop();
});

test('bootstrap hooks expose observed lifecycle state and bind start/stop', async () => {
  const lifecycle = new RustStorageLifecycle(fakeAdapter());
  const hooks = rustStorageBootstrapHooks(lifecycle);
  assert.equal(hooks.getStorageStatus().running, false);
  await hooks.startStorage();
  assert.equal(hooks.getStorageStatus().running, true);
  await hooks.stopStorage();
  assert.equal(hooks.getStorageStatus().running, false);
});
