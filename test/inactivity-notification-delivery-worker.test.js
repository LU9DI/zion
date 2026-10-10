import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InactivityNotificationStore } from '../src/inactivity-notification-store.js';
import { InactivityNotificationDeliveryWorker } from '../src/inactivity-notification-delivery-worker.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-delivery-worker-'));
  const store = new InactivityNotificationStore({ statePath: join(dir, 'notifications.json') });
  return { dir, store, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const event = { type: 'pause-warning', message: 'A contribuição será pausada por inatividade.' };

test('worker delivers pending notifications and confirms only provider receipts', async () => {
  const f = fixture();
  try {
    const a = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const b = (await f.store.enqueue({ ownerIdentityId: 'bob', event })).notification;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice', 'bob'],
      deliver: async notification => ({ delivered: true, receipt: `receipt-${notification.id}` }) });
    const result = await worker.runOnce();
    assert.equal(result.delivered, 2);
    assert.equal((await f.store.list('alice'))[0].deliveryStatus, 'delivered');
    assert.equal((await f.store.list('bob'))[0].deliveryStatus, 'delivered');
    assert.equal((await f.store.list('alice'))[0].deliveryReceipt, `receipt-${a.id}`);
    assert.equal((await f.store.list('bob'))[0].deliveryReceipt, `receipt-${b.id}`);
    await worker.stop();
  } finally { f.close(); }
});

test('failed provider attempt remains pending and uses exponential backoff', async () => {
  const f = fixture();
  try {
    await f.store.enqueue({ ownerIdentityId: 'alice', event });
    let now = Date.now();
    let sends = 0;
    const keys = [];
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliver: async item => { sends++; keys.push(item.idempotencyKey); return { delivered: false }; },
      now: () => now, baseBackoffMs: 100, maxBackoffMs: 1000 });
    assert.equal((await worker.runOnce()).failed, 1);
    assert.equal((await f.store.list('alice'))[0].deliveryStatus, 'pending');
    assert.equal((await worker.runOnce()).deferred, 1);
    assert.equal(sends, 1);
    now += 1000;
    assert.equal((await worker.runOnce()).failed, 1);
    assert.equal(sends, 2);
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^zion-inactivity-notification:/);
    await worker.stop();
  } finally { f.close(); }
});

test('worker avoids concurrent duplicate runs and permanently stops', async () => {
  const f = fixture();
  try {
    await f.store.enqueue({ ownerIdentityId: 'alice', event });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliver: async () => { calls++; await gate; return { delivered: true, receipt: 'receipt' }; } });
    const first = worker.runOnce();
    const second = worker.runOnce();
    release();
    assert.equal((await first).delivered, 1);
    assert.equal((await second).delivered, 1);
    await worker.stop();
    assert.throws(() => worker.start(), /stopped permanently/);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('invalid owner provider fails closed and reports a bounded error', async () => {
  const f = fixture();
  try {
    const errors = [];
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice', 7], deliver: async () => ({ delivered: true, receipt: 'x' }),
      onError: error => errors.push(error) });
    const result = await worker.runOnce();
    assert.equal(result.ok, false);
    assert.equal(result.status, 'worker-error');
    assert.equal(errors.length, 1);
    await worker.stop();
  } finally { f.close(); }
});

test('worker claims are exclusive across independent store instances and passes stable idempotency key', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const secondStore = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json') });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const keys = [];
    let sends = 0;
    const options = {
      listOwnerIdentityIds: async () => ['alice'],
      deliver: async item => { sends++; keys.push(item.idempotencyKey); await gate; return { delivered: true, receipt: 'receipt-1' }; },
    };
    const first = new InactivityNotificationDeliveryWorker({ store: f.store, ...options });
    const second = new InactivityNotificationDeliveryWorker({ store: secondStore, ...options });
    const a = first.runOnce();
    await new Promise(resolve => setTimeout(resolve, 20));
    const b = second.runOnce();
    release();
    const results = await Promise.all([a, b]);
    assert.equal(sends, 1);
    assert.equal(results.reduce((sum, item) => sum + item.delivered, 0), 1);
    assert.equal(keys[0], `zion-inactivity-notification:${record.id}`);
    assert.equal((await secondStore.list('alice'))[0].deliveryStatus, 'delivered');
    await Promise.all([first.stop(), second.stop()]);
  } finally { f.close(); }
});

test('delivery claim expires and can be recovered after a crashed worker', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    let now = Date.now();
    const store = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json'), now: () => new Date(now).toISOString() });
    const claim = await store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    assert.ok(claim?.claimToken);
    assert.equal(await store.claimDelivery('alice', record.id, { leaseMs: 1_000 }), null);
    now += 1_001;
    const recovered = await store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    assert.ok(recovered?.claimToken);
    assert.notEqual(recovered.claimToken, claim.claimToken);
    await assert.rejects(() => store.confirmDelivered('alice', record.id, 'receipt-old', claim.claimToken), /claim is no longer valid/);
    await store.releaseDeliveryClaim('alice', record.id, recovered.claimToken);
  } finally { f.close(); }
});


test('attempt persistence failure releases its claim immediately', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const originalRecordAttempt = f.store.recordAttempt.bind(f.store);
    f.store.recordAttempt = async () => { throw new Error('simulated disk failure'); };
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliver: async () => ({ delivered: true, receipt: 'should-not-send' }) });
    const result = await worker.runOnce();
    assert.equal(result.failed, 1);
    assert.equal(result.status, 'completed');
    // Restore the operation and verify another worker can claim immediately, rather than
    // waiting for the full delivery lease to expire.
    f.store.recordAttempt = originalRecordAttempt;
    const claim = await f.store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    assert.ok(claim?.claimToken);
    await f.store.releaseDeliveryClaim('alice', record.id, claim.claimToken);
    await worker.stop();
  } finally { f.close(); }
});


test('stale worker cannot increment attempts after its delivery claim is replaced', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    let now = Date.now();
    const store = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json'), now: () => new Date(now).toISOString() });
    const oldClaim = await store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    now += 1_001;
    const currentClaim = await store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    await assert.rejects(() => store.recordAttempt('alice', record.id, oldClaim.claimToken), /claim is no longer valid/);
    assert.equal((await store.list('alice'))[0].attempts, 0);
    await store.recordAttempt('alice', record.id, currentClaim.claimToken);
    assert.equal((await store.list('alice'))[0].attempts, 1);
    await store.releaseDeliveryClaim('alice', record.id, currentClaim.claimToken);
  } finally { f.close(); }
});

test('persisted notification state rejects malformed delivery claims on reload', async () => {
  const f = fixture();
  try {
    await f.store.enqueue({ ownerIdentityId: 'alice', event });
    const path = join(f.dir, 'notifications.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.notifications[0].deliveryClaimToken = 'claim-without-lease';
    writeFileSync(path, JSON.stringify(state));
    assert.throws(() => new InactivityNotificationStore({ statePath: path }), /Invalid persisted notification record/);
  } finally { f.close(); }
});


test('ambiguous provider outcome is quarantined from automatic resend until reconciliation', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    let sends = 0;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'],
      deliver: async () => { sends++; return { outcome: 'unknown', reason: 'connection-lost-after-submit' }; } });
    const first = await worker.runOnce();
    assert.equal(first.ambiguous, 1);
    assert.equal((await f.store.list('alice', { status: 'ambiguous' }))[0].id, record.id);
    const second = await worker.runOnce();
    assert.equal(second.ambiguous, 1);
    assert.equal(sends, 1, 'ambiguous item must not be blindly resent');
    await worker.stop();
  } finally { f.close(); }
});

test('reconciliation resolves ambiguous delivery to delivered or safely retryable', async () => {
  const f = fixture();
  try {
    const delivered = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const notDelivered = (await f.store.enqueue({ ownerIdentityId: 'alice', event: { ...event, message: 'Segunda notificação' } })).notification;
    for (const record of [delivered, notDelivered]) {
      const claim = await f.store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
      await f.store.markDeliveryAmbiguous('alice', record.id, claim.claimToken, 'simulated-uncertain-result');
    }
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'],
      deliver: async () => ({ delivered: true, receipt: 'should-not-send' }),
      reconcile: async record => record.id === delivered.id
        ? { outcome: 'delivered', receipt: 'provider-reconciled-receipt' }
        : { outcome: 'not-delivered' } });
    const result = await worker.runOnce();
    const records = await f.store.list('alice');
    assert.equal(records.find(item => item.id === delivered.id).deliveryStatus, 'delivered');
    assert.equal(records.find(item => item.id === notDelivered.id).deliveryStatus, 'pending');
    assert.equal(result.reconciled, 2);
    assert.equal(result.delivered, 1);
    await worker.stop();
  } finally { f.close(); }
});


test('network timeout from provider is recorded as ambiguous, not blindly retried', async () => {
  const f = fixture();
  try {
    await f.store.enqueue({ ownerIdentityId: 'alice', event });
    let sends = 0;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'],
      deliver: async () => { sends++; const error = new Error('socket timed out'); error.code = 'ETIMEDOUT'; throw error; } });
    const first = await worker.runOnce();
    assert.equal(first.ambiguous, 1);
    await worker.runOnce();
    assert.equal(sends, 1);
    assert.equal((await f.store.list('alice'))[0].deliveryStatus, 'ambiguous');
    await worker.stop();
  } finally { f.close(); }
});

test('hung provider is aborted and moved to ambiguous state within bounded timeout', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    let signal;
    let sends = 0;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliveryLeaseMs: 1_000, providerTimeoutMs: 100,
      deliver: async item => { sends++; signal = item.signal; return new Promise(() => {}); } });
    const startedAt = Date.now();
    const result = await worker.runOnce();
    assert.ok(Date.now() - startedAt < 2_000, 'timeout should bound the worker wait');
    assert.equal(result.ambiguous, 1);
    assert.equal(sends, 1);
    assert.equal(signal.aborted, true);
    assert.equal((await f.store.list('alice', { status: 'ambiguous' }))[0].id, record.id);
    await worker.stop();
  } finally { f.close(); }
});

test('graceful worker shutdown aborts in-flight delivery and persists ambiguous outcome', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    let signal;
    let sends = 0;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliveryLeaseMs: 1_000, providerTimeoutMs: 800,
      deliver: async item => { sends++; signal = item.signal; return new Promise(() => {}); } });
    const running = worker.runOnce();
    while (!signal) await new Promise(resolve => setTimeout(resolve, 5));
    const stoppedAt = Date.now();
    await worker.stop();
    const result = await running;
    assert.ok(Date.now() - stoppedAt < 500, 'shutdown should not wait for the provider timeout');
    assert.equal(signal.aborted, true);
    assert.equal(sends, 1);
    assert.equal(result.ambiguous, 1);
    assert.equal((await f.store.list('alice', { status: 'ambiguous' }))[0].id, record.id);
    assert.equal(worker.snapshot().stopped, true);
  } finally { f.close(); }
});

test('hung reconciliation is bounded and keeps the record ambiguous for a later reconciliation', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const initialClaim = await f.store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    await f.store.markDeliveryAmbiguous('alice', record.id, initialClaim.claimToken, 'unknown-result');
    let signal;
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliveryLeaseMs: 1_000, providerTimeoutMs: 100,
      deliver: async () => ({ delivered: true, receipt: 'must-not-send' }),
      reconcile: async item => { signal = item.signal; return new Promise(() => {}); } });
    const result = await worker.runOnce();
    assert.equal(result.failed, 1);
    assert.equal(signal.aborted, true);
    assert.equal((await f.store.list('alice', { status: 'ambiguous' }))[0].id, record.id);
    const claim = await f.store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    assert.ok(claim?.claimToken, 'timed-out reconciliation must release its claim');
    await f.store.releaseDeliveryClaim('alice', record.id, claim.claimToken);
    await worker.stop();
  } finally { f.close(); }
});

test('worker rejects timeout longer than or equal to its delivery lease', async () => {
  const f = fixture();
  try {
    assert.throws(() => new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'], deliver: async () => ({}),
      deliveryLeaseMs: 1_000, providerTimeoutMs: 1_000 }), /Invalid inactivity notification delivery worker configuration/);
  } finally { f.close(); }
});


test('real child-process crash leaves a recoverable persisted claim after lease expiry', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const statePath = join(f.dir, 'notifications.json');
    const source = `import { InactivityNotificationStore } from ${JSON.stringify(new URL('../src/inactivity-notification-store.js', import.meta.url).href)};\nconst store = new InactivityNotificationStore({ statePath: ${JSON.stringify(statePath)} });\nconst claim = await store.claimDelivery('alice', ${JSON.stringify(record.id)}, { leaseMs: 1000 });\nif (!claim?.claimToken) process.exit(3);\nprocess.stdout.write(claim.claimToken);\n// Exit without releasing the claim to simulate abrupt process termination.\nprocess.exit(0);`;
    const oldToken = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }).trim();
    assert.ok(oldToken);
    const whileLeaseActive = await f.store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    assert.equal(whileLeaseActive, null, 'restart must respect a still-active persisted lease');
    await new Promise(resolve => setTimeout(resolve, 1_050));
    const restartedStore = new InactivityNotificationStore({ statePath });
    const recovered = await restartedStore.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    assert.ok(recovered?.claimToken, 'a new process can recover the claim after its lease expires');
    assert.notEqual(recovered.claimToken, oldToken);
    await assert.rejects(() => restartedStore.confirmDelivered('alice', record.id, 'stale-receipt', oldToken), /claim is no longer valid/);
    await restartedStore.releaseDeliveryClaim('alice', record.id, recovered.claimToken);
  } finally { f.close(); }
});

test('real child-process crash after durable dispatch intent is recovered as ambiguous', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const statePath = join(f.dir, 'notifications.json');
    const source = `import { InactivityNotificationStore } from ${JSON.stringify(new URL('../src/inactivity-notification-store.js', import.meta.url).href)};\nconst store = new InactivityNotificationStore({ statePath: ${JSON.stringify(statePath)} });\nconst claim = await store.claimDelivery('alice', ${JSON.stringify(record.id)}, { leaseMs: 1000 });\nif (!claim?.claimToken) process.exit(3);\nawait store.recordAttempt('alice', ${JSON.stringify(record.id)}, claim.claimToken);\nawait store.markDeliveryStarted('alice', ${JSON.stringify(record.id)}, claim.claimToken);\nprocess.stdout.write('dispatch-intent-durable');\nprocess.exit(73);`;
    let output = '';
    try { execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }); }
    catch (error) { output = error.stdout || ''; assert.equal(error.status, 73); }
    assert.match(output, /dispatch-intent-durable/);
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')).notifications.find(item => item.id === record.id);
    assert.equal(persisted.deliveryStatus, 'pending');
    assert.ok(persisted.deliveryStartedAt, 'intent must be durable before process exits');
    await new Promise(resolve => setTimeout(resolve, 1_050));
    const restartedStore = new InactivityNotificationStore({ statePath });
    assert.equal(await restartedStore.claimDelivery('alice', record.id, { leaseMs: 1_000 }), null);
    const [recovered] = await restartedStore.list('alice', { status: 'ambiguous' });
    assert.equal(recovered.deliveryAmbiguityReason, 'worker-crash-during-delivery');
    assert.equal(recovered.deliveryStartedAt, undefined);
  } finally { f.close(); }
});

test('ambiguous delivery state survives store reconstruction and is reconciled before resend', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const firstClaim = await f.store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    await f.store.markDeliveryAmbiguous('alice', record.id, firstClaim.claimToken, 'process-ended-after-submit');
    const restartedStore = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json') });
    let sends = 0;
    let reconciles = 0;
    const worker = new InactivityNotificationDeliveryWorker({
      store: restartedStore,
      listOwnerIdentityIds: async () => ['alice'],
      deliver: async () => { sends++; return { delivered: true, receipt: 'unexpected-resend' }; },
      reconcile: async () => { reconciles++; return { outcome: 'delivered', receipt: 'recovered-provider-receipt' }; },
    });
    const result = await worker.runOnce();
    const saved = (await restartedStore.list('alice'))[0];
    assert.equal(result.reconciled, 1);
    assert.equal(saved.deliveryStatus, 'delivered');
    assert.equal(saved.deliveryReceipt, 'recovered-provider-receipt');
    assert.equal(reconciles, 1);
    assert.equal(sends, 0, 'restarted worker must reconcile ambiguous records before any resend');
    await worker.stop();
  } finally { f.close(); }
});

test('expired dispatch intent after process crash becomes ambiguous instead of being resent', async () => {
  const f = fixture();
  try {
    let nowMs = Date.parse('2026-10-09T12:00:00.000Z');
    const statePath = join(f.dir, 'notifications.json');
    const store = new InactivityNotificationStore({ statePath, now: () => new Date(nowMs).toISOString() });
    const record = (await store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const claim = await store.claimDelivery('alice', record.id, { leaseMs: 1_000 });
    await store.recordAttempt('alice', record.id, claim.claimToken);
    await store.markDeliveryStarted('alice', record.id, claim.claimToken);

    // Simulate a process dying without provider receipt or cleanup.
    nowMs += 1_001;
    const restartedStore = new InactivityNotificationStore({ statePath, now: () => new Date(nowMs).toISOString() });
    assert.equal(await restartedStore.claimDelivery('alice', record.id, { leaseMs: 1_000 }), null);
    const saved = (await restartedStore.list('alice', { status: 'ambiguous' }))[0];
    assert.equal(saved.deliveryAmbiguityReason, 'worker-crash-during-delivery');
    assert.equal(saved.deliveryStartedAt, undefined);
    assert.equal(saved.deliveryClaimToken, undefined);
  } finally { f.close(); }
});

test('provider success whose receipt cannot be persisted is fenced into ambiguity', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event })).notification;
    const originalConfirm = f.store.confirmDelivered.bind(f.store);
    f.store.confirmDelivered = async () => { throw new Error('simulated durable write failure'); };
    const worker = new InactivityNotificationDeliveryWorker({ store: f.store,
      listOwnerIdentityIds: async () => ['alice'],
      deliver: async () => ({ delivered: true, receipt: 'provider-receipt-123' }) });
    const result = await worker.runOnce();
    assert.equal(result.ambiguous, 1);
    const saved = (await f.store.list('alice'))[0];
    assert.equal(saved.id, record.id);
    assert.equal(saved.deliveryStatus, 'ambiguous');
    assert.equal(saved.deliveryAmbiguityReason, 'receipt-persistence-failed');
    f.store.confirmDelivered = originalConfirm;
    await worker.stop();
  } finally { f.close(); }
});
