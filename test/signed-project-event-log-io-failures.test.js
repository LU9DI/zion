import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
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
  test(`${kind} rolls back a journal-file descriptor close failure and retries that close`, async t => {
    const f = fixture();
    const path = kind === 'event log' ? f.path : join(f.dir, 'replica.events');
    let source;
    let journal;
    const originalClose = fs.closeSync.bind(fs);
    let journalFdCloseAttempts = 0;
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
        if (fs.fstatSync(fd).isFile()) {
          journalFdCloseAttempts++;
          if (journalFdCloseAttempts === 1) {
            throw Object.assign(new Error('injected journal descriptor close failure'), { code: 'EIO' });
          }
        }
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
      assert.equal(journalFdCloseAttempts, 2);
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

for (const kind of ['event log', 'replica']) {
  test(`${kind} fails closed after an abrupt child-process exit during a partial append`, async t => {
    const f = fixture();
    const path = kind === 'event log' ? f.path : join(f.dir, 'replica.events');
    let source;
    try {
      let recordArg = 'null';
      let childSetup;
      if (kind === 'event log') {
        childSetup = `
          import { createNodeIdentity } from './src/peer-security.js';
          import { SignedProjectEventLog } from './src/signed-project-event-log.js';
          const journal = new SignedProjectEventLog(path, { identity: createNodeIdentity() });
          const append = () => journal.append({ projectId: '${PROJECT}', eventType: 'PROJECT_CREATED', data: {} });
        `;
      } else {
        source = new SignedProjectEventLog(f.path, { identity: f.identity });
        await source.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
        recordArg = JSON.stringify(source.snapshotRecords().records[0]);
        childSetup = `
          import { SignedProjectEventReplica } from './src/signed-project-event-replica.js';
          const journal = new SignedProjectEventReplica(path, { authorizePeer: () => true });
          const record = JSON.parse(process.argv[2]);
          const append = () => journal.ingest(record);
        `;
      }
      const script = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const path = process.argv[1];
        ${childSetup}
        const originalWrite = fs.writeSync.bind(fs);
        let injected = false;
        fs.writeSync = (...args) => {
          if (!injected) {
            injected = true;
            originalWrite(args[0], args[1], args[2], Math.min(7, args[3]));
            process.exit(86);
          }
          return originalWrite(...args);
        };
        syncBuiltinESMExports();
        await append();
        process.exit(87);
      `;
      const args = kind === 'event log'
        ? ['--input-type=module', '-e', script, path]
        : ['--input-type=module', '-e', script, path, recordArg];
      const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15_000 });
      assert.equal(child.status, 86, child.stderr || child.stdout);
      // The lock is intentionally left by a crashed process. This test performs
      // explicit operator recovery before validating the journal bytes.
      rmSync(`${path}.lock`, { force: true });
      assert.equal(readFileSync(path).length, 7);
      assert.throws(() => kind === 'event log'
        ? new SignedProjectEventLog(path, { identity: f.identity })
        : new SignedProjectEventReplica(path, { authorizePeer: () => true }),
      error => error.code === (kind === 'event log' ? 'ZION_EVENT_LOG_CORRUPT' : 'ZION_REPLICA_CORRUPT'));
    } finally {
      try { source?.close(); } catch { /* Preserve the test failure. */ }
      f.cleanup();
    }
  });
}
