import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { SignedProjectEventLog } from '../src/signed-project-event-log.js';

const PROJECT = 'a'.repeat(64);
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-event-log-'));
  const path = join(dir, 'project.events');
  const identity = createNodeIdentity();
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, path, identity, cleanup, options };
}

test('signed event log appends ordered, hash-chained events and replays after restart', async () => {
  const f = fixture();
  try {
    let now = 1_000;
    let log = new SignedProjectEventLog(f.path, { identity: f.identity, now: () => now });
    const first = await log.append({ projectId: PROJECT, eventType: 'FILE_CREATED', data: { objectId: 'obj-1' } });
    now += 500;
    const second = await log.append({ projectId: PROJECT, eventType: 'FILE_UPDATED', data: { objectId: 'obj-1', version: 2 } });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousHash, first.recordHash);
    assert.equal(log.snapshot().count, 2);
    log.close();

    now += 10_000_000_000;
    log = new SignedProjectEventLog(f.path, { identity: f.identity, now: () => now });
    const snapshot = log.snapshot();
    assert.equal(snapshot.count, 2);
    assert.equal(snapshot.events[0].eventType, 'FILE_CREATED');
    assert.equal(snapshot.events[1].sequence, 2);
    assert.equal(snapshot.lastHash, second.recordHash);
    log.close();
  } finally { f.cleanup(); }
});

test('event log rejects a second process opening the same journal', () => {
  const f = fixture();
  try {
    const first = new SignedProjectEventLog(f.path, { identity: f.identity });
    assert.throws(() => new SignedProjectEventLog(f.path, { identity: f.identity }), { code: 'ZION_EVENT_LOG_LOCKED' });
    first.close();
    const reopened = new SignedProjectEventLog(f.path, { identity: f.identity });
    reopened.close();
  } finally { f.cleanup(); }
});

test('event log recovers a stale lock written by a terminated process', async () => {
  const f = fixture();
  try {
    writeFileSync(f.path + '.lock', JSON.stringify({ pid: 2147483647, token: 'stale-lock-token' }) + '\n');
    const log = new SignedProjectEventLog(f.path, { identity: f.identity });
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { recovered: true } });
    assert.equal(log.snapshot().count, 1);
    log.close();
    assert.equal(readFileSync(f.path + '.lock', 'utf8').length, 0);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  } finally { f.cleanup(); }
});

test('event log fails closed on a truncated trailing record', async () => {
  const f = fixture();
  try {
    const log = new SignedProjectEventLog(f.path, { identity: f.identity });
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
    log.close();
    writeFileSync(f.path, Buffer.concat([readFileSync(f.path), Buffer.from('{"partial":')]));
    assert.throws(() => new SignedProjectEventLog(f.path, { identity: f.identity }), { code: 'ZION_EVENT_LOG_CORRUPT' });
  } finally { f.cleanup(); }
});

test('event log detects record tampering and refuses to recover silently', async () => {
  const f = fixture();
  try {
    const log = new SignedProjectEventLog(f.path, { identity: f.identity });
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { name: 'alpha' } });
    log.close();
    const record = JSON.parse(readFileSync(f.path, 'utf8'));
    record.recordHash = 'f'.repeat(64);
    writeFileSync(f.path, JSON.stringify(record) + '\n');
    assert.throws(() => new SignedProjectEventLog(f.path, { identity: f.identity }), { code: 'ZION_EVENT_LOG_CORRUPT' });
  } finally { f.cleanup(); }
});

test('event log rejects a journal signed by a different node identity', async () => {
  const f = fixture();
  try {
    const log = new SignedProjectEventLog(f.path, { identity: f.identity });
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
    log.close();
    assert.throws(() => new SignedProjectEventLog(f.path, { identity: createNodeIdentity() }), { code: 'ZION_EVENT_LOG_CORRUPT' });
  } finally { f.cleanup(); }
});

test('event log validates input and enforces bounded capacity', async () => {
  const f = fixture();
  try {
    const log = new SignedProjectEventLog(f.path, { identity: f.identity, maxRecords: 1 });
    await assert.rejects(log.append({ projectId: 'bad', eventType: 'INVALID', data: {} }), TypeError);
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
    await assert.rejects(log.append({ projectId: PROJECT, eventType: 'PROJECT_UPDATED', data: {} }), { code: 'ZION_EVENT_LOG_TOO_LARGE' });
    assert.equal(log.snapshot().count, 1);
    log.close();
  } finally { f.cleanup(); }
});

test('event log serializes concurrent appends into a single sequence', async () => {
  const f = fixture();
  try {
    const log = new SignedProjectEventLog(f.path, { identity: f.identity });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      log.append({ projectId: PROJECT, eventType: 'ACTIVITY_RECORDED', data: { index: i } })));
    assert.deepEqual(results.map(x => x.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(log.snapshot().count, 20);
    log.close();
  } finally { f.cleanup(); }
});
