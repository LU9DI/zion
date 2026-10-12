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
