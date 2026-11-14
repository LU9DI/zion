import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('close preserves a replacement lock owned by another writer', () => {
  const f = fixture();
  try {
    const journal = new DurableCommittedBlockJournal(f.path);
    const replacement = JSON.stringify({ pid: process.pid + 1, token: 'replacement-lock-token' }) + '\n';
    writeFileSync(f.path + '.lock', replacement);
    journal.close();
    assert.equal(existsSync(f.path + '.lock'), true);
    assert.equal(readFileSync(f.path + '.lock', 'utf8'), replacement);
    assert.deepEqual(JSON.parse(readFileSync(f.path + '.lock', 'utf8')), {
      pid: process.pid + 1,
      token: 'replacement-lock-token',
    });
  } finally { f.cleanup(); }
});

test('journal refuses a symbolic-link path without modifying its target', {
  skip: process.platform === 'win32',
}, () => {
  const f = fixture();
  const target = join(f.dir, 'outside-target');
  try {
    writeFileSync(target, 'do-not-modify');
    symlinkSync(target, f.path);
    assert.throws(
      () => new DurableCommittedBlockJournal(f.path),
      { code: 'ZION_JOURNAL_SYMLINK' },
    );
    assert.equal(readFileSync(target, 'utf8'), 'do-not-modify');
    assert.equal(existsSync(f.path + '.lock'), false);
  } finally { f.cleanup(); }
});

test('journal refuses a directory as its data file and cleans up its owned lock', () => {
  const f = fixture();
  const directoryPath = join(f.dir, 'journal-directory');
  try {
    mkdirSync(directoryPath);
    assert.throws(
      () => new DurableCommittedBlockJournal(directoryPath),
      { code: 'ZION_JOURNAL_NOT_REGULAR' },
    );
    assert.equal(existsSync(directoryPath + '.lock'), false);
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

    writeFileSync(f.path, original);
    const hashTamper = JSON.parse(original.toString('utf8').trim());
    hashTamper.recordHash = '0'.repeat(64);
    writeFileSync(f.path, JSON.stringify(hashTamper) + '\n');
    assert.throws(() => new DurableCommittedBlockJournal(f.path), { code: 'ZION_JOURNAL_CORRUPT' });
  } finally { f.cleanup(); }
});

test('height gaps and unverified stale-lock cleanup are rejected', () => {
  const f = fixture();
  try {
    const journal = new DurableCommittedBlockJournal(f.path);
    const base = finalized(1, 'durable-operation-0004', 'base', 'v1');
    const next = new CommittedStateHarness(new MemoryAtomicCommittedStateStore(base.state))
      .finalizeBlock({
        height: 2,
        transactions: [{ operationId: 'durable-operation-0009', type: 'SET', key: 'k', value: 'v' }],
      });
    assert.throws(() => journal.commit(2, next.state), {
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


test('write-boundary failures roll back the record, poison the writer, and recover empty', () => {
  for (const faultAt of ['before-write', 'after-partial-write', 'before-fsync', 'after-fsync']) {
    const f = fixture();
    try {
      const journal = new DurableCommittedBlockJournal(f.path, { faultAt });
      const block = finalized(1, 'durable-fault-operation-0001', 'fault.test', faultAt);
      assert.throws(
        () => journal.commit(1, block.state),
        { code: 'ZION_JOURNAL_INJECTED_FAILURE' },
      );
      assert.equal(readFileSync(f.path).length, 0, faultAt);
      assert.throws(
        () => journal.commit(1, block.state),
        { code: 'ZION_JOURNAL_UNAVAILABLE' },
      );
      journal.close();

      const recovered = new DurableCommittedBlockJournal(f.path);
      assert.equal(recovered.info().lastBlockHeight, 0, faultAt);
      assert.equal(recovered.read(), null, faultAt);
      recovered.close();
    } finally { f.cleanup(); }
  }
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
