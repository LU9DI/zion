import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { SignedProjectEventLog } from '../src/signed-project-event-log.js';
import { SignedProjectEventReplica } from '../src/signed-project-event-replica.js';

const PROJECT = 'b'.repeat(64);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-journal-io-failure-'));
  const identity = createNodeIdentity();
  return {
    dir,
    path: join(dir, 'source.events'),
    identity,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function restoreMocks(t) {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

for (const kind of ['event log', 'replica']) {
  test(`${kind} remains unavailable and recovery fails closed when rollback truncate fails`, async t => {
    const f = fixture();
    const path = kind === 'event log' ? f.path : join(f.dir, 'replica.events');
    let source;
    let journal;
    const originalWrite = fs.writeSync.bind(fs);
    const originalTruncate = fs.ftruncateSync.bind(fs);
    let writeInjected = false;
    try {
      if (kind === 'event log') {
        journal = new SignedProjectEventLog(path, { identity: f.identity });
      } else {
        source = new SignedProjectEventLog(f.path, { identity: f.identity });
        await source.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
        const record = source.snapshotRecords().records[0];
        journal = new SignedProjectEventReplica(path, { authorizePeer: () => true });
        t.mock.method(fs, 'writeSync', (...args) => {
          if (!writeInjected) {
            writeInjected = true;
            originalWrite(args[0], args[1], args[2], Math.min(7, args[3]));
            throw Object.assign(new Error('injected partial write failure'), { code: 'EIO' });
          }
          return originalWrite(...args);
        });
        t.mock.method(fs, 'ftruncateSync', () => {
          throw Object.assign(new Error('injected rollback truncate failure'), { code: 'EIO' });
        });
        syncBuiltinESMExports();
        await assert.rejects(journal.ingest(record), error =>
          error.code === 'EIO' && error.rollbackSucceeded === false &&
          error.rollbackError?.code === 'EIO');
      }

      if (kind === 'event log') {
        t.mock.method(fs, 'writeSync', (...args) => {
          if (!writeInjected) {
            writeInjected = true;
            originalWrite(args[0], args[1], args[2], Math.min(7, args[3]));
            throw Object.assign(new Error('injected partial write failure'), { code: 'EIO' });
          }
          return originalWrite(...args);
        });
        t.mock.method(fs, 'ftruncateSync', () => {
          throw Object.assign(new Error('injected rollback truncate failure'), { code: 'EIO' });
        });
        syncBuiltinESMExports();
        await assert.rejects(
          journal.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} }),
          error => error.code === 'EIO' && error.rollbackSucceeded === false &&
            error.rollbackError?.code === 'EIO',
        );
      }

      restoreMocks(t);
      assert.equal(readFileSync(path).length, 7);
      if (kind === 'event log') {
        await assert.rejects(journal.append({ projectId: PROJECT, eventType: 'PROJECT_UPDATED', data: {} }),
          { code: 'ZION_EVENT_LOG_UNAVAILABLE' });
      } else {
        await assert.rejects(journal.ingest({}), { code: 'ZION_REPLICA_UNAVAILABLE' });
      }
      journal.close();
      assert.throws(() => kind === 'event log'
        ? new SignedProjectEventLog(path, { identity: f.identity })
        : new SignedProjectEventReplica(path, { authorizePeer: () => true }),
      error => error.code === (kind === 'event log' ? 'ZION_EVENT_LOG_CORRUPT' : 'ZION_REPLICA_CORRUPT'));
    } finally {
      restoreMocks(t);
      try { journal?.close(); } catch { /* Preserve the test failure. */ }
      try { source?.close(); } catch { /* Preserve the test failure. */ }
      f.cleanup();
    }
  });
}

for (const kind of ['event log', 'replica']) {
  test(`${kind} rolls back a close failure and retries descriptor close`, async t => {
    const f = fixture();
    const path = kind === 'event log' ? f.path : join(f.dir, 'replica.events');
    let source;
    let journal;
    const originalClose = fs.closeSync.bind(fs);
    let closeCalls = 0;
    try {
      let record;
      if (kind === 'event log') {
        journal = new SignedProjectEventLog(path, { identity: f.identity });
      } else {
        source = new SignedProjectEventLog(f.path, { identity: f.identity });
        await source.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
        record = source.snapshotRecords().records[0];
        journal = new SignedProjectEventReplica(path, { authorizePeer: () => true });
      }

      t.mock.method(fs, 'closeSync', fd => {
        closeCalls++;
        if (closeCalls === 1) throw Object.assign(new Error('injected descriptor close failure'), { code: 'EIO' });
        return originalClose(fd);
      });
      syncBuiltinESMExports();

      if (kind === 'event log') {
        await assert.rejects(
          journal.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} }),
          { code: 'EIO', rollbackSucceeded: true },
        );
      } else {
        await assert.rejects(journal.ingest(record), { code: 'EIO', rollbackSucceeded: true });
      }

      restoreMocks(t);
      assert.equal(closeCalls, 2);
      assert.equal(readFileSync(path).length, 0);
      if (kind === 'event log') {
        assert.equal(journal.snapshot().count, 0);
        await assert.rejects(journal.append({ projectId: PROJECT, eventType: 'PROJECT_UPDATED', data: {} }),
          { code: 'ZION_EVENT_LOG_UNAVAILABLE' });
      } else {
        assert.equal(journal.snapshot().records, 0);
        await assert.rejects(journal.ingest(record), { code: 'ZION_REPLICA_UNAVAILABLE' });
      }
      journal.close();
      const recovered = kind === 'event log'
        ? new SignedProjectEventLog(path, { identity: f.identity })
        : new SignedProjectEventReplica(path, { authorizePeer: () => true });
      assert.equal(kind === 'event log' ? recovered.snapshot().count : recovered.snapshot().records, 0);
      recovered.close();
    } finally {
      restoreMocks(t);
      try { journal?.close(); } catch { /* Preserve the test failure. */ }
      try { source?.close(); } catch { /* Preserve the test failure. */ }
      f.cleanup();
    }
  });
}
