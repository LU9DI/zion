import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FilePeerAdmissionStateStore } from '../src/peer-admission-file-state-store.js';
import { PeerAdmissionController } from '../src/peer-admission-controller.js';
import { createNodeIdentity, } from '../src/peer-security.js';
import { createPeerIntroductionVoucher } from '../src/peer-introduction-vouchers.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-peer-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'nested', 'admission-state.json');
}

test('file store round-trips state through a new instance', t => {
  const path = fixture(t), store = new FilePeerAdmissionStateStore(path);
  assert.deepEqual(store.load(), { version: 1, consumed: [], admissions: [] });
  const state = {
    version: 1, consumed: ['a'.repeat(64) + ':' + 'b'.repeat(32)],
    admissions: [{ subjectNodeId: 'c'.repeat(64), issuerNodeIds: ['d'.repeat(64), 'e'.repeat(64)] }],
  };
  store.save(state);
  assert.deepEqual(new FilePeerAdmissionStateStore(path).load(), state);
});

test('file store rejects corruption instead of resetting replay protection', t => {
  const path = fixture(t), store = new FilePeerAdmissionStateStore(path);
  store.save({ version: 1, consumed: [], admissions: [] });
  writeFileSync(path, '{"version":1,"state":{"version":1,"consumed":[],"admissions":[]},"checksum":"bad"}');
  assert.throws(() => store.load(), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
});

test('file store enforces size limits on reads and writes', t => {
  const path = fixture(t), store = new FilePeerAdmissionStateStore(path, { maxBytes: 1024 });
  assert.throws(() => store.save({
    version: 1, consumed: Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(64, '0') + ':' + (i + 1).toString(16).padStart(32, '0')), admissions: [],
  }), { code: 'ZION_ADMISSION_STATE_TOO_LARGE' });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x'.repeat(1025));
  assert.throws(() => store.load(), { code: 'ZION_ADMISSION_STATE_TOO_LARGE' });
});

test('file store is usable by the admission controller across controller restarts', async t => {
  const path = fixture(t), stateStore = new FilePeerAdmissionStateStore(path);
  const issuerA = createNodeIdentity(), issuerB = createNodeIdentity(), subject = createNodeIdentity();
  const vouchers = [
    createPeerIntroductionVoucher({ issuerIdentity: issuerA, subjectNodeId: subject.nodeId }),
    createPeerIntroductionVoucher({ issuerIdentity: issuerB, subjectNodeId: subject.nodeId }),
  ];
  const config = {
    trustedIssuerNodeIds: [issuerA.nodeId, issuerB.nodeId], threshold: 2,
    capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 0.5 }),
    stateStore,
  };
  assert.equal((await new PeerAdmissionController(config).admit({ subjectNodeId: subject.nodeId, vouchers })).ok, true);
  assert.equal(new PeerAdmissionController(config).isAdmitted(subject.nodeId), true);
  assert.equal((await new PeerAdmissionController(config).admit({ subjectNodeId: subject.nodeId, vouchers })).reason, 'subject-already-admitted');
});

test('file store rejects duplicate consumed invitation keys and duplicate admission identities', t => {
  const path = fixture(t), store = new FilePeerAdmissionStateStore(path);
  const key = 'a'.repeat(64) + ':' + 'b'.repeat(32);
  const subject = 'c'.repeat(64), issuer = 'd'.repeat(64);
  assert.throws(() => store.save({
    version: 1, consumed: [key, key],
    admissions: [{ subjectNodeId: subject, issuerNodeIds: [issuer] }],
  }), TypeError);
  assert.throws(() => store.save({
    version: 1, consumed: [key],
    admissions: [
      { subjectNodeId: subject, issuerNodeIds: [issuer] },
      { subjectNodeId: subject, issuerNodeIds: ['e'.repeat(64)] },
    ],
  }), TypeError);
  assert.throws(() => store.save({
    version: 1, consumed: [key],
    admissions: [{ subjectNodeId: subject, issuerNodeIds: [issuer, issuer] }],
  }), TypeError);
  assert.throws(() => store.save({
    version: 1, consumed: ['malformed-key'],
    admissions: [{ subjectNodeId: subject, issuerNodeIds: [issuer] }],
  }), TypeError);
});
