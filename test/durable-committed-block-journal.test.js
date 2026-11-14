import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CommittedStateHarness, MemoryAtomicCommittedStateStore } from './support/committed-state-harness.js';
import { DurableCommittedBlockJournal } from './support/durable-committed-block-journal.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-committed-journal-'));
  const path = join(dir, 'committed.blocks');
  return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function finalized(height, operationId, key, value) {
  const app = new CommittedStateHarness();
  return app.finalizeBlock({
    height,
    transactions: [{ operationId, type: 'SET', key, value }],
  });
}

test('durable journal reopens the complete committed snapshot and rejects concurrent writers', () => {
  const f = fixture();
  try {
    const first = new DurableCommittedBlockJournal(f.path);
    const block = finalized(1, 'durable-operation-0001', 'profile.name', 'Zion');
    const committed = first.commit(1, block.state);
    assert.equal(committed.lastBlockHeight, 1);
    assert.throws(() => new DurableCommittedBlockJournal(f.path), { code: 'EEXIST' });
    first.close();

    const reopened = new DurableCommittedBlockJournal(f.path);
    assert.deepEqual(reopened.read(), block.state);
    assert.equal(reopened.info().appHash, block.appHash);
    reopened.close();
  } finally { f.cleanup(); }
});

test('process termination immediately after fsync is recovered as committed', () => {
  const f = fixture();
  try {
    const block = finalized(1, 'durable-operation-0002', 'profile.status', 'active');
    const moduleUrl = new URL('./support/durable-committed-block-journal.js', import.meta.url).href;
    const script = [
      'import { DurableCommittedBlockJournal } from ' + JSON.stringify(moduleUrl) + ';',
      'const journal = new DurableCommittedBlockJournal(' + JSON.stringify(f.path) + ', { crashAfterFsync: true });',
      'journal.commit(1, ' + JSON.stringify(block.state) + ');',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 86, child.stderr);
    DurableCommittedBlockJournal.clearStaleLockAfterVerification(f.path, { verifiedNoWriter: true });

    const recovered = new DurableCommittedBlockJournal(f.path);
    assert.equal(recovered.info().lastBlockHeight, 1);
    assert.deepEqual(recovered.read(), block.state);
    recovered.close();
  } finally { f.cleanup(); }
});

test('incomplete and modified journal records fail closed on recovery', () => {
  const f = fixture();
  try {
    const journal = new DurableCommittedBlockJournal(f.path);
    journal.commit(1, finalized(1, 'durable-operation-0003', 'k', 'v').state);
    journal.close();
    const original = readFileSync(f.path);
    writeFileSync(f.path, Buffer.concat([original, Buffer.from('{"partial":')]));
    assert.throws(() => new DurableCommittedBlockJournal(f.path), { code: 'ZION_JOURNAL_CORRUPT' });

    writeFileSync(f.path, original);
    const parsed = JSON.parse(original.toString('utf8').trim());
    parsed.state.data.k = 'tampered';
    writeFileSync(f.path, JSON.stringify(parsed) + '\n');
    assert.throws(() => new DurableCommittedBlockJournal(f.path), { code: 'ZION_JOURNAL_STATE_ROOT_MISMATCH' });
  } finally { f.cleanup(); }
});

test('height gaps and unverified stale-lock cleanup are rejected', () => {
  const f = fixture();
  try {
    const journal = new DurableCommittedBlockJournal(f.path);
    assert.throws(() => journal.commit(2, finalized(2, 'durable-operation-0004', 'k', 'v').state), {
      code: 'ZION_JOURNAL_HEIGHT_CONFLICT',
    });
    assert.throws(() => DurableCommittedBlockJournal.clearStaleLockAfterVerification(f.path), /Explicit confirmation/);
    journal.close();
  } finally { f.cleanup(); }
});

test('same-height commit retry is idempotent and conflicting replay fails closed', () => {
  const f = fixture();
  try {
    const journal = new DurableCommittedBlockJournal(f.path);
    const first = finalized(1, 'durable-operation-0005', 'k', 'v1');
    const conflict = finalized(1, 'durable-operation-0006', 'k', 'v2');
    journal.commit(1, first.state);
    assert.equal(journal.commit(1, first.state).status, 'already-committed');
    assert.throws(
      () => journal.commit(1, conflict.state),
      { code: 'ZION_JOURNAL_COMMIT_CONFLICT' },
    );
    journal.close();

    const reopened = new DurableCommittedBlockJournal(f.path);
    assert.equal(reopened.commit(1, first.state).status, 'already-committed');
    assert.equal(reopened.info().lastBlockHeight, 1);
    reopened.close();
  } finally { f.cleanup(); }
});

test('multiple committed heights recover the latest state through a verified hash chain', () => {
  const f = fixture();
  try {
    const journal = new DurableCommittedBlockJournal(f.path);
    const first = finalized(1, 'durable-operation-0007', 'profile.name', 'Zion');
    journal.commit(1, first.state);
    const nextApp = new CommittedStateHarness(
      new MemoryAtomicCommittedStateStore(first.state),
    );
    const second = nextApp.finalizeBlock({
      height: 2,
      transactions: [{ operationId: 'durable-operation-0008', type: 'SET', key: 'profile.status', value: 'active' }],
    });
    journal.commit(2, second.state);
    journal.close();

    const recovered = new DurableCommittedBlockJournal(f.path);
    assert.equal(recovered.info().lastBlockHeight, 2);
    assert.equal(recovered.read().data['profile.name'], 'Zion');
    assert.equal(recovered.read().data['profile.status'], 'active');
    recovered.close();
  } finally { f.cleanup(); }
});
