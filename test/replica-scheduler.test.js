import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplicas } from '../src/replica-scheduler.js';
const id = 'a'.repeat(64);
const nodes = [
  { id: 'n1', online: true, acceptingStorage: true, availableBytes: 1000, failureDomain: 'home-a', resourceBudget: { enabled: true } },
  { id: 'n2', online: true, acceptingStorage: true, availableBytes: 1000, failureDomain: 'home-b', resourceBudget: { enabled: true } },
  { id: 'n3', online: true, acceptingStorage: true, availableBytes: 1000, failureDomain: 'home-c', resourceBudget: { enabled: true } },
  { id: 'n4', online: false, acceptingStorage: true, availableBytes: 1000, resourceBudget: { enabled: true } },
];
test('selects only eligible nodes and distinct failure domains', () => {
  const p = planReplicas({ chunkId: id, nodes, replicaCount: 3 });
  assert.equal(p.placements.length, 3); assert.equal(p.underReplicated, false);
  assert.equal(new Set(p.placements.map(x => x.failureDomain)).size, 3);
});
test('reports under-replication rather than pretending availability', () => {
  const p = planReplicas({ chunkId: id, nodes: nodes.slice(0, 1), replicaCount: 3 });
  assert.equal(p.placements.length, 1); assert.equal(p.underReplicated, true);
});
test('excluded nodes are never selected', () => {
  const p = planReplicas({ chunkId: id, nodes, replicaCount: 2, excludedNodeIds: ['n1', 'n2', 'n3'] });
  assert.equal(p.placements.length, 0); assert.equal(p.underReplicated, true);
});


test('excludes quarantined or explicitly unverified peers even when otherwise eligible', () => {
  const guarded = [
    { id: 'quarantined', online: true, acceptingStorage: true, quarantined: true, availableBytes: 1000, resourceBudget: { enabled: true } },
    { id: 'unverified', online: true, acceptingStorage: true, integrityStatus: 'unknown', availableBytes: 1000, resourceBudget: { enabled: true } },
    { id: 'verified', online: true, acceptingStorage: true, integrityStatus: 'verified', availableBytes: 1000, resourceBudget: { enabled: true } },
  ];
  const p = planReplicas({ chunkId: id, nodes: guarded, replicaCount: 3 });
  assert.deepEqual(p.placements.map(x => x.nodeId), ['verified']);
  assert.equal(p.underReplicated, true);
});
