import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { SignedProjectEventLog, verifySignedProjectEventRecord } from '../src/signed-project-event-log.js';
import { SignedProjectEventReplica } from '../src/signed-project-event-replica.js';

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
    assert.throws(() => readFileSync(f.path + '.lock', 'utf8'), { code: 'ENOENT' });
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

test('event log exposes bounded signed records that remote peers can verify', async () => {
  const f = fixture();
  try {
    let now = 1_800_000_000_000;
    const log = new SignedProjectEventLog(f.path, { identity: f.identity, now: () => now });
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { name: 'alpha' } });
    now += 1;
    await log.append({ projectId: PROJECT, eventType: 'PROJECT_UPDATED', data: { version: 2 } });
    const page = log.snapshotRecords({ afterSequence: 0, limit: 1 });
    assert.equal(page.fromSequence, 1);
    assert.equal(page.nextSequence, 2);
    assert.equal(page.lastSequence, 2);
    assert.equal(page.records.length, 1);
    const verified = verifySignedProjectEventRecord(page.records[0], { now, maxClockSkewMs: 120_000 });
    assert.equal(verified.ok, true);
    assert.equal(verified.nodeId, f.identity.nodeId);
    assert.equal(verified.event.sequence, 1);
    const tampered = JSON.parse(JSON.stringify(page.records[0]));
    tampered.recordHash = 'f'.repeat(64);
    assert.equal(verifySignedProjectEventRecord(tampered, { now, maxClockSkewMs: 120_000 }).ok, false);
    assert.equal(log.snapshotRecords({ afterSequence: 1, limit: 256 }).records.length, 1);
    assert.throws(() => log.snapshotRecords({ afterSequence: -1 }), /replication cursor/);
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


test('replica durably accepts authorized contiguous records, deduplicates, and recovers after restart', async () => {
  const f = fixture();
  const replicaPath = join(f.dir, 'replica.events');
  try {
    let now = 1_800_000_000_000;
    const source = new SignedProjectEventLog(f.path, { identity: f.identity, now: () => now });
    await source.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { name: 'replicated' } });
    now += 1;
    await source.append({ projectId: PROJECT, eventType: 'PROJECT_UPDATED', data: { version: 2 } });
    const records = source.snapshotRecords({ limit: 2 }).records;
    const replica = new SignedProjectEventReplica(replicaPath, {
      authorizePeer: (nodeId, projectId) => nodeId === f.identity.nodeId && projectId === PROJECT,
      now: () => now,
    });
    await assert.rejects(replica.ingest(records[1]), { code: 'ZION_REPLICA_GAP' });
    const first = await replica.ingest(records[0]);
    assert.equal(first.accepted, true);
    const duplicate = await replica.ingest(records[0]);
    assert.equal(duplicate.duplicate, true);
    const second = await replica.ingest(records[1]);
    assert.equal(second.sequence, 2);
    assert.equal(replica.snapshot().records, 2);
    replica.close();
    source.close();

    now += 10_000_000_000;
    const recovered = new SignedProjectEventReplica(replicaPath, {
      authorizePeer: () => true,
      now: () => now,
    });
    assert.equal(recovered.snapshot().records, 2);
    assert.equal(recovered.snapshot().peers[0].sequence, 2);
    recovered.close();
  } finally { f.cleanup(); }
});

test('replica rejects peers not authorized for the event project', async () => {
  const f = fixture();
  try {
    let now = 1_800_000_000_000;
    const source = new SignedProjectEventLog(f.path, { identity: f.identity, now: () => now });
    await source.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: {} });
    const record = source.snapshotRecords().records[0];
    const replica = new SignedProjectEventReplica(join(f.dir, 'unauthorized.events'), {
      authorizePeer: () => false,
      now: () => now,
    });
    await assert.rejects(replica.ingest(record), { code: 'ZION_REPLICA_UNAUTHORIZED' });
    assert.equal(replica.snapshot().records, 0);
    replica.close();
    source.close();
  } finally { f.cleanup(); }
});


test('replica detects equivocation when one peer signs conflicting events at the same sequence', async () => {
  const f = fixture();
  const alternatePath = join(f.dir, 'alternate.events');
  try {
    let now = 1_800_000_000_000;
    const firstLog = new SignedProjectEventLog(f.path, { identity: f.identity, now: () => now });
    const alternateLog = new SignedProjectEventLog(alternatePath, { identity: f.identity, now: () => now });
    await firstLog.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { name: 'canonical' } });
    await alternateLog.append({ projectId: PROJECT, eventType: 'PROJECT_CREATED', data: { name: 'conflicting' } });
    const firstRecord = firstLog.snapshotRecords().records[0];
    const conflictingRecord = alternateLog.snapshotRecords().records[0];
    const replica = new SignedProjectEventReplica(join(f.dir, 'equivocation.events'), {
      authorizePeer: () => true,
      now: () => now,
    });
    await replica.ingest(firstRecord);
    await assert.rejects(replica.ingest(conflictingRecord), { code: 'ZION_REPLICA_EQUIVOCATION' });
    assert.equal(replica.snapshot().records, 1);
    replica.close();
    firstLog.close();
    alternateLog.close();
  } finally { f.cleanup(); }
});
