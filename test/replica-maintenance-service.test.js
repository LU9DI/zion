import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReplicaCatalog } from '../src/replica-catalog.js';
import { ReplicaMaintenanceService } from '../src/replica-maintenance-service.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const receipt = (chunkId, nodeId, bytes) => ({ chunkId, nodeId, storedBytes: bytes, storedAt: Date.now(), requestId: randomBytes(16).toString('hex') });

 test('repairs an under-replicated catalog entry and persists the new receipt', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envelope = Buffer.concat([Buffer.from('REAC1'), randomBytes(128)]);
  const chunkId = hash(envelope);
  const oldNode = 'a'.repeat(64), newNode = 'b'.repeat(64), ownerNode = 'c'.repeat(64);
  const catalog = new ReplicaCatalog(path.join(root, 'catalog'));
  await catalog.init();
  await catalog.recordReplication({ chunkId, bytes: envelope.length, desiredReplicas: 2, receipts: [receipt(chunkId, oldNode, envelope.length)] });
  const localStore = { get: async id => { assert.equal(id, chunkId); return envelope; } };
  let replicateArgs;
  const coordinator = { identity: { nodeId: ownerNode }, replicate: async args => {
    replicateArgs = args;
    return { receipts: [receipt(chunkId, newNode, envelope.length)], confirmedReplicas: 1, underReplicated: false };
  } };
  const service = new ReplicaMaintenanceService({ catalog, sourceStore: localStore, recoveryService: {}, coordinator });
  const socket = { destroyed: false, writable: true };
  const result = await service.repairChunk({ chunkId, peers: [
    { nodeId: oldNode, socket }, { nodeId: newNode, socket }, { nodeId: ownerNode, socket }
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.confirmedReplicas, 2);
  assert.deepEqual(replicateArgs.excludedNodeIds, [oldNode]);
  assert.deepEqual(replicateArgs.peers.map(peer => peer.nodeId), [newNode]);
  const reloaded = new ReplicaCatalog(path.join(root, 'catalog'));
  await reloaded.init();
  assert.equal((await reloaded.get(chunkId)).status, 'replication-confirmed');
 });

test('fails closed when no verified source is available for repair', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-maintenance-no-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from('REAC1'), randomBytes(64)]);
  const chunkId = hash(bytes), oldNode = 'a'.repeat(64), ownerNode = 'c'.repeat(64);
  const catalog = new ReplicaCatalog(path.join(root, 'catalog'));
  await catalog.init();
  await catalog.recordReplication({ chunkId, bytes: bytes.length, desiredReplicas: 2, receipts: [receipt(chunkId, oldNode, bytes.length)] });
  const service = new ReplicaMaintenanceService({ catalog, sourceStore: { get: async () => { throw new Error('missing'); } },
    recoveryService: { recover: async () => ({ ok: false, reason: 'no-verified-replica-available' }) },
    coordinator: { identity: { nodeId: ownerNode }, replicate: async () => { throw new Error('must not replicate without source'); } } });
  const result = await service.repairChunk({ chunkId, peers: [{ nodeId: oldNode, socket: { destroyed: false, writable: true } }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-verified-source-for-repair');
  assert.equal((await catalog.get(chunkId)).receipts.length, 1);
});

test('does not count invalid local bytes as a repair source', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rea-maintenance-invalid-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.concat([Buffer.from('REAC1'), randomBytes(64)]), chunkId = hash(bytes);
  const oldNode = 'a'.repeat(64), ownerNode = 'c'.repeat(64);
  const catalog = new ReplicaCatalog(path.join(root, 'catalog'));
  await catalog.init();
  await catalog.recordReplication({ chunkId, bytes: bytes.length, desiredReplicas: 2, receipts: [receipt(chunkId, oldNode, bytes.length)] });
  const service = new ReplicaMaintenanceService({ catalog, sourceStore: { get: async () => Buffer.from('not-the-chunk') },
    recoveryService: { recover: async () => ({ ok: false }) }, coordinator: { identity: { nodeId: ownerNode }, replicate: async () => { throw new Error('must not replicate'); } } });
  const result = await service.repairChunk({ chunkId, peers: [{ nodeId: oldNode, socket: { destroyed: false, writable: true } }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-verified-source-for-repair');
});


test('refuses replica maintenance before catalog or peer access when local integrity is quarantined', async () => {
  let catalogReads = 0, peerCalls = 0;
  const service = new ReplicaMaintenanceService({
    catalog: { get: async () => { catalogReads++; throw new Error('must not read catalog'); } },
    recoveryService: { recover: async () => { peerCalls++; throw new Error('must not contact peers'); } },
    coordinator: { identity: { nodeId: 'c'.repeat(64) }, replicate: async () => { peerCalls++; throw new Error('must not replicate'); } },
    integrityGuard: { checkHealthy: async () => { throw Object.assign(new Error('tampered'), { code: 'ZION_INTEGRITY_QUARANTINED' }); } }
  });
  const result = await service.repairChunk({ chunkId: 'a'.repeat(64), peers: [{ nodeId: 'b'.repeat(64), socket: { destroyed: false, writable: true } }] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local-integrity-not-healthy');
  assert.equal(catalogReads, 0);
  assert.equal(peerCalls, 0);
});


test('official replica maintenance refuses to start without a valid integrity guard', () => {
  const base = { catalog: {}, recoveryService: {}, coordinator: { identity: { nodeId: 'c'.repeat(64) } }, networkMode: 'official' };
  assert.throws(() => new ReplicaMaintenanceService(base), /Official Zion mode requires a verified IntegrityGuard/);
  assert.throws(() => new ReplicaMaintenanceService({ ...base, integrityGuard: { assertHealthy() {}, status: { verified: true, quarantined: false } } }), /Official Zion mode requires a verified IntegrityGuard/);
  assert.throws(() => new ReplicaMaintenanceService({ ...base, integrityGuard: { checkHealthy: async () => {}, assertHealthy() {}, status: { verified: false, quarantined: false } } }), /Official Zion mode requires a verified IntegrityGuard/);
  assert.doesNotThrow(() => new ReplicaMaintenanceService({ ...base, integrityGuard: { async checkHealthy() {}, assertHealthy() {}, status: { verified: true, quarantined: false } } }));
});

test('official maintenance refuses operations if guard is already quarantined, without touching catalog or peers', async () => {
  let catalogReads = 0, peerCalls = 0;
  const guard = { status: { verified: true, quarantined: false }, async checkHealthy() { if (this.status.quarantined) throw new Error('quarantined'); }, assertHealthy() { if (this.status.quarantined) throw new Error('quarantined'); } };
  const service = new ReplicaMaintenanceService({ networkMode: 'official', integrityGuard: guard,
    catalog: { get: async () => { catalogReads++; return null; } },
    recoveryService: { recover: async () => { peerCalls++; return { ok: false }; } },
    coordinator: { identity: { nodeId: 'c'.repeat(64) }, replicate: async () => { peerCalls++; return { receipts: [] }; } }
  });
  guard.status = { verified: false, quarantined: true };
  const result = await service.repairChunk({ chunkId: 'a'.repeat(64), peers: [] });
  assert.equal(result.reason, 'local-integrity-not-healthy');
  assert.equal(catalogReads, 0);
  assert.equal(peerCalls, 0);
});
