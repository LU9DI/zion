import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { SignedProjectEventLog } from '../src/signed-project-event-log.js';
import { SignedProjectEventReplica } from '../src/signed-project-event-replica.js';
import { createSignedProjectEventReplicationHandler, sendSignedProjectEventRecord } from '../src/signed-project-event-transport.js';
import { PeerTransport } from '../src/peer-transport.js';

const PROJECT = 'b'.repeat(64);
const waitFor = async predicate => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for peer event replication');
};

test('replicates a signed project event over authenticated P2P transport and acknowledges durable duplicates', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-event-transport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceIdentity = createNodeIdentity();
  const receiverIdentity = createNodeIdentity();
  const sourceLog = new SignedProjectEventLog(join(dir, 'source.events'), { identity: sourceIdentity });
  t.after(() => sourceLog.close());
  await sourceLog.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { name: 'p2p' } });
  const record = sourceLog.snapshotRecords().records[0];

  const replica = new SignedProjectEventReplica(join(dir, 'replica.events'), {
    authorizePeer: (nodeId, projectId) => nodeId === sourceIdentity.nodeId && projectId === PROJECT,
  });
  t.after(() => replica.close());

  const receiver = new PeerTransport({
    identity: receiverIdentity,
    onMessage: async (message, socket) => handler(message, socket),
  });
  const handler = createSignedProjectEventReplicationHandler({ replica, transport: receiver });
  const address = await receiver.listen();
  t.after(() => receiver.close());

  let acknowledgements = [];
  const sender = new PeerTransport({
    identity: sourceIdentity,
    onMessage: async message => {
      if (message.payload.type === 'PROJECT_EVENT_REPLICATION_ACK') acknowledgements.push(message.payload);
    },
  });
  t.after(() => sender.close());
  const socket = await sender.connect('127.0.0.1', address.port);
  t.after(() => socket.destroy());

  const requestId = sendSignedProjectEventRecord({ transport: sender, socket, record });
  await waitFor(() => acknowledgements.length === 1);
  assert.equal(acknowledgements[0].requestId, requestId);
  assert.equal(acknowledgements[0].accepted, true);
  assert.equal(acknowledgements[0].duplicate, false);
  assert.equal(replica.snapshot().records, 1);

  sendSignedProjectEventRecord({ transport: sender, socket, record });
  await waitFor(() => acknowledgements.length === 2);
  assert.equal(acknowledgements[1].accepted, false);
  assert.equal(acknowledgements[1].duplicate, true);
  assert.equal(replica.snapshot().records, 1);
});

test('sender adapter refuses to relay an event signed by another node', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-event-transport-signer-'));
  try {
    const signer = createNodeIdentity();
    const unrelatedTransportIdentity = createNodeIdentity();
    const log = new SignedProjectEventLog(join(dir, 'other.events'), { identity: signer });
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
    const record = log.snapshotRecords().records[0];
    const transport = new PeerTransport({ identity: unrelatedTransportIdentity });
    const socket = { destroyed: false };
    assert.throws(() => sendSignedProjectEventRecord({ transport, socket, record }), {
      code: 'ZION_REPLICATION_LOCAL_SIGNER_MISMATCH',
    });
    log.close();
    await transport.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
