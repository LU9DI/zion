import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const workerPath = fileURLToPath(new URL('./helpers/peer-node-worker.js', import.meta.url));
let nextId = 1;

function spawnPeer(t, name) {
  const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map();
  const events = [];
  child.on('message', message => {
    if (message.event) events.push(message);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.ok ? resolve(message.result) : reject(Object.assign(new Error(message.error), { code: message.code }));
    }
  });
  const call = (action, args = {}) => new Promise((resolve, reject) => {
    const id = `${name}-${nextId++}`;
    pending.set(id, { resolve, reject });
    child.send({ id, action, ...args });
  });
  t.after(async () => {
    if (child.connected) {
      try { await call('close'); } catch {}
      child.disconnect();
    }
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  return { child, call, events };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for independent peer process');
    await delay(10);
  }
}

test('three independent Node.js processes isolate the compromised peer and preserve healthy communication', async t => {
  const a = spawnPeer(t, 'A');
  const b = spawnPeer(t, 'B');
  const c = spawnPeer(t, 'C');
  const [addrA, addrB, addrC] = await Promise.all([a.call('listen'), b.call('listen'), c.call('listen')]);
  assert.ok(addrA.port > 0 && addrB.port > 0 && addrC.port > 0);

  await Promise.all([
    a.call('connect', { name: 'toB', port: addrB.port }),
    c.call('connect', { name: 'toB', port: addrB.port }),
    a.call('connect', { name: 'toC', port: addrC.port })
  ]);

  const bStatus = await b.call('quarantine', { reason: 'hash-mismatch:src/peer-transport.js' });
  assert.equal(bStatus.quarantined, true);
  assert.equal(bStatus.listening, false);
  await waitFor(() => bStatus.connections === 0);

  const statusA = await a.call('status');
  const statusC = await c.call('status');
  assert.equal(statusA.quarantined, false);
  assert.equal(statusC.quarantined, false);
  assert.equal(statusA.listening, true);
  assert.equal(statusC.listening, true);

  await a.call('send', { name: 'toC', nonce: 'after-quarantine-process-test' });
  await waitFor(() => c.events.some(event => event.event === 'received' && event.payload.nonce === 'after-quarantine-process-test'));
  assert.ok(c.events.some(event => event.event === 'received' && event.payload.nonce === 'after-quarantine-process-test'));
  await assert.rejects(a.call('send', { name: 'toB', nonce: 'must-not-send-to-quarantined-peer' }), /not writable|quarantined/i);

  const finalB = await b.call('status');
  assert.equal(finalB.started, false);
  assert.equal(finalB.connections, 0);
});
