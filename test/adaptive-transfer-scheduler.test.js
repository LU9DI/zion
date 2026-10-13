import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveBandwidthPolicy } from '../src/adaptive-bandwidth-policy.js';
import { AdaptiveTransferScheduler } from '../src/adaptive-transfer-scheduler.js';

const healthy = { telemetryHealthy: true, userActive: true, networkBusy: 0, measuredUploadKiBps: 10, measuredDownloadKiBps: 10 };
function fakeSocket() {
  return { destroyed: false, writable: true, writes: [], write(frame, callback) { this.writes.push(Buffer.from(frame)); callback?.(); return true; } };
}

test('scheduler writes through policy-limited queue and resolves byte accounting', async () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 10, activeUploadFraction: 1, activeDownloadFraction: 1 });
  const scheduler = new AdaptiveTransferScheduler({ policy, getTelemetry: () => healthy });
  const socket = fakeSocket();
  try {
    const result = await scheduler.enqueue(socket, Buffer.from('hello'));
    assert.equal(result.bytes, 5);
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.writes[0].toString(), 'hello');
  } finally { scheduler.close(); }
});

test('scheduler honors token refill delay instead of polling while under budget', async () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 10, activeUploadFraction: 1, activeDownloadFraction: 1 });
  let time = 0;
  let telemetryCalls = 0;
  const scheduler = new AdaptiveTransferScheduler({
    policy,
    getTelemetry: () => { telemetryCalls++; return healthy; },
    now: () => ++time,
    minTickMs: 10
  });
  const pending = scheduler.enqueue(fakeSocket(), Buffer.alloc(1025, 0x62));
  try {
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(telemetryCalls, 1, 'scheduler should wait for the computed refill interval');
  } finally {
    scheduler.close();
  }
  await assert.rejects(pending, /Transfer scheduler is closed/);
});

test('scheduler eventually sends a frame larger than one second of bandwidth budget', async () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 10, activeUploadFraction: 1, activeDownloadFraction: 1 });
  let time = 0;
  const scheduler = new AdaptiveTransferScheduler({
    policy,
    getTelemetry: () => healthy,
    now: () => { time += 2000; return time; }
  });
  const socket = fakeSocket();
  try {
    const frame = Buffer.alloc(10 * 1024 + 1, 0x61);
    const sent = scheduler.enqueue(socket, frame);
    await Promise.race([
      sent,
      new Promise((_, reject) => setTimeout(() => reject(new Error('oversized frame remained starved')), 100))
    ]);
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.writes[0].length, frame.length);
  } finally { scheduler.close(); }
});

test('scheduler rejects queued transfers when the bandwidth policy throws', async () => {
  const policy = { evaluate() { throw new Error('policy evaluation failed'); } };
  const scheduler = new AdaptiveTransferScheduler({ policy, getTelemetry: () => healthy });
  try {
    await assert.rejects(scheduler.enqueue(fakeSocket(), Buffer.from('data')), /policy evaluation failed/);
    assert.equal(scheduler.queuedBytes, 0);
    assert.equal(scheduler.queue.length, 0);
  } finally { scheduler.close(); }
});

test('scheduler fails closed when telemetry is unavailable', async () => {
  const policy = new AdaptiveBandwidthPolicy();
  const scheduler = new AdaptiveTransferScheduler({ policy, getTelemetry: () => null });
  try {
    await assert.rejects(scheduler.enqueue(fakeSocket(), Buffer.from('data')), /disabled/);
  } finally { scheduler.close(); }
});

test('scheduler rejects queue overflow and closed sockets', async () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 10, activeUploadFraction: 1, activeDownloadFraction: 1 });
  const scheduler = new AdaptiveTransferScheduler({ policy, getTelemetry: () => healthy, maxQueuedBytes: 3 });
  try {
    await assert.rejects(scheduler.enqueue(fakeSocket(), Buffer.from('four')), /capacity/);
    const socket = fakeSocket(); socket.destroyed = true;
    await assert.rejects(scheduler.enqueue(socket, Buffer.from('x')), /not writable/);
  } finally { scheduler.close(); }
});

test('scheduler close releases pump when telemetry never resolves', async () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 10, activeUploadFraction: 1, activeDownloadFraction: 1 });
  let markTelemetryStarted;
  const telemetryStarted = new Promise(resolve => { markTelemetryStarted = resolve; });
  const scheduler = new AdaptiveTransferScheduler({
    policy,
    getTelemetry: () => { markTelemetryStarted(); return new Promise(() => {}); }
  });
  const pending = scheduler.enqueue(fakeSocket(), Buffer.from('waiting'));
  await telemetryStarted;
  scheduler.close();
  await assert.rejects(pending, /Transfer scheduler is closed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.pumping, false);
});
 
test('scheduler close rejects an in-flight write whose callback never returns', async () => {
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 10, activeUploadFraction: 1, activeDownloadFraction: 1 });
  const scheduler = new AdaptiveTransferScheduler({ policy, getTelemetry: () => healthy });
  let markWriteStarted;
  const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
  const socket = { destroyed: false, writable: true, write() { markWriteStarted(); return true; } };
  const pending = scheduler.enqueue(socket, Buffer.from('stalled'));
  await writeStarted;
  assert.ok(scheduler.activeItem, 'write should be in flight');
  scheduler.close();
  await assert.rejects(pending, /Transfer scheduler is closed/);
  assert.equal(scheduler.activeItem, null);
});
