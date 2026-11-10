import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PostgresPeerRevocationListener } from '../src/peer-admission-postgres-listener.js';

const id = digit => digit.repeat(64);

function fakePool() {
  const clients = [];
  return {
    clients,
    async connect() {
      const client = new EventEmitter();
      client.queries = [];
      client.released = false;
      client.query = async sql => { client.queries.push(sql); return { rows: [] }; };
      client.release = () => { client.released = true; };
      clients.push(client);
      return client;
    },
  };
}

test('listener uses a dedicated LISTEN session and accepts only validated revocation payloads', async () => {
  const pool = fakePool();
  const received = [];
  const listener = new PostgresPeerRevocationListener({
    pool, onRevocation: async nodeId => { received.push(nodeId); },
  });
  await listener.start();
  assert.deepEqual(pool.clients[0].queries, ['LISTEN zion_peer_revocations']);
  pool.clients[0].emit('notification', { channel: 'other_channel', payload: id('a') });
  pool.clients[0].emit('notification', { channel: 'zion_peer_revocations', payload: 'malformed' });
  pool.clients[0].emit('notification', { channel: 'zion_peer_revocations', payload: id('b') });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [id('b')]);
  await listener.stop();
  assert.equal(pool.clients[0].released, true);
});

test('listener reconnects after a dedicated session ends and stops without leaving a retry timer', async () => {
  const pool = fakePool();
  const received = [];
  const listener = new PostgresPeerRevocationListener({
    pool, onRevocation: nodeId => received.push(nodeId),
    minReconnectMs: 10, maxReconnectMs: 20,
  });
  await listener.start();
  pool.clients[0].emit('end');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pool.clients.length, 2);
  pool.clients[1].emit('notification', { channel: 'zion_peer_revocations', payload: id('c') });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [id('c')]);
  await listener.stop();
  assert.equal(pool.clients[1].released, true);
  assert.equal(listener.running, false);
});

test('listener detaches its event handlers before returning a client to the pool', async () => {
  const pool = fakePool();
  const listener = new PostgresPeerRevocationListener({
    pool, onRevocation: () => {},
    minReconnectMs: 10, maxReconnectMs: 20,
  });
  await listener.start();
  const client = pool.clients[0];
  assert.equal(client.listenerCount('notification'), 1);
  assert.equal(client.listenerCount('error'), 1);
  assert.equal(client.listenerCount('end'), 1);
  await listener.stop();
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('end'), 0);
  assert.equal(client.released, true);
});

test('listener detaches failed-session handlers before reconnecting', async () => {
  const pool = fakePool();
  const listener = new PostgresPeerRevocationListener({
    pool, onRevocation: () => {},
    minReconnectMs: 10, maxReconnectMs: 20,
  });
  await listener.start();
  const failedClient = pool.clients[0];
  failedClient.emit('end');
  assert.equal(failedClient.listenerCount('notification'), 0);
  assert.equal(failedClient.listenerCount('error'), 0);
  assert.equal(failedClient.listenerCount('end'), 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pool.clients.length, 2);
  await listener.stop();
});
