import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { InactivityNotificationStore, createInactivityNotificationAdapter } from '../src/inactivity-notification-store.js';

const event = (type = 'pause-warning', extra = {}) => ({ type, message: 'Aviso de inatividade', ...extra });
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-notifications-'));
  const store = new InactivityNotificationStore({ statePath: join(dir, 'notifications.json'), ...options });
  return { dir, store, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('persists notifications and isolates reads by owner identity', async () => {
  const f = fixture();
  try {
    const created = await f.store.enqueue({ ownerIdentityId: 'alice', event: event() });
    assert.equal(created.created, true);
    assert.equal((await f.store.list('alice')).length, 1);
    assert.equal((await f.store.list('bob')).length, 0);
    const reopened = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json') });
    assert.equal((await reopened.list('alice'))[0].id, created.notification.id);
  } finally { f.close(); }
});

test('deduplicates a repeated event key and does not create duplicate warnings', async () => {
  const f = fixture();
  try {
    const first = await f.store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'pause:123' });
    const second = await f.store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'pause:123' });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.notification.id, second.notification.id);
    assert.equal((await f.store.list('alice')).length, 1);
  } finally { f.close(); }
});

test('delivery status requires an explicit provider receipt and is separate from viewed status', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event: event() })).notification;
    await f.store.recordAttempt('alice', record.id);
    assert.equal((await f.store.list('alice'))[0].deliveryStatus, 'pending');
    await f.store.markViewed('alice', record.id);
    assert.ok((await f.store.list('alice'))[0].viewedAt);
    await f.store.confirmDelivered('alice', record.id, 'provider-receipt-1');
    const delivered = (await f.store.list('alice'))[0];
    assert.equal(delivered.deliveryStatus, 'delivered');
    assert.equal(delivered.deliveryReceipt, 'provider-receipt-1');
    assert.equal(delivered.attempts, 1);
  } finally { f.close(); }
});

test('rejects cross-owner mutation and invalid receipts', async () => {
  const f = fixture();
  try {
    const record = (await f.store.enqueue({ ownerIdentityId: 'alice', event: event() })).notification;
    await assert.rejects(f.store.markViewed('bob', record.id), { code: 'NOTIFICATION_NOT_FOUND' });
    assert.throws(() => f.store.confirmDelivered('alice', record.id, ''), /Invalid provider delivery receipt/);
    assert.equal((await f.store.list('alice'))[0].deliveryStatus, 'pending');
  } finally { f.close(); }
});

test('outbox full condition preserves pending notifications', async () => {
  const f = fixture({ maxRecords: 1 });
  try {
    await f.store.enqueue({ ownerIdentityId: 'alice', event: event() });
    await assert.rejects(f.store.enqueue({ ownerIdentityId: 'alice', event: event('contribution-paused') }), { code: 'NOTIFICATION_OUTBOX_FULL' });
    assert.equal((await f.store.list('alice')).length, 1);
  } finally { f.close(); }
});

test('policy adapter queues durable notifications and confirms only provider-confirmed delivery', async () => {
  const f = fixture();
  try {
    const adapter = createInactivityNotificationAdapter({ store: f.store, ownerIdentityId: 'alice', deliver: async () => ({ delivered: false }) });
    const result = await adapter(event());
    assert.equal(result.queued, true);
    assert.equal(result.delivered, false);
    assert.equal((await f.store.list('alice'))[0].deliveryStatus, 'pending');
    const confirmed = createInactivityNotificationAdapter({ store: f.store, ownerIdentityId: 'alice', deliver: async () => ({ delivered: true, receipt: 'smtp-accepted-42' }) });
    const result2 = await confirmed(event('contribution-paused'));
    assert.equal(result2.delivered, true);
    assert.equal((await f.store.list('alice')).find(x => x.id === result2.id).deliveryReceipt, 'smtp-accepted-42');

    const uncertain = createInactivityNotificationAdapter({ store: f.store, ownerIdentityId: 'alice', deliver: async () => { throw new Error('connection reset after request'); } });
    const result3 = await uncertain(event('capacity-reduction-warning'));
    assert.equal(result3.ambiguous, true);
    assert.equal((await f.store.list('alice')).find(x => x.id === result3.id).deliveryStatus, 'ambiguous');
  } finally { f.close(); }
});

test('validates notification type and bounded payload', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.enqueue({ ownerIdentityId: 'alice', event: event('arbitrary-event') }), /Invalid inactivity notification event/);
    assert.throws(() => f.store.enqueue({ ownerIdentityId: 'alice', event: event('pause-warning', { message: 'x'.repeat(1001) }) }), /Invalid notification message/);
  } finally { f.close(); }
});


test('coordinates independent store instances sharing one outbox file', async () => {
  const f = fixture();
  try {
    const second = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json') });
    const writes = Array.from({ length: 40 }, (_, i) => (i % 2 ? f.store : second).enqueue({
      ownerIdentityId: 'alice', event: event('pause-warning', { message: `Concurrent warning ${i}` }),
    }));
    const results = await Promise.all(writes);
    assert.equal(results.length, 40);
    const records = await f.store.list('alice', { limit: 100 });
    assert.equal(records.length, 40);
    assert.equal(new Set(records.map(record => record.id)).size, 40);
    const reopened = new InactivityNotificationStore({ statePath: join(f.dir, 'notifications.json') });
    assert.equal((await reopened.list('alice', { limit: 100 })).length, 40);
  } finally { f.close(); }
});

test('rejects a symlink used as the outbox lock file', async () => {
  const { symlinkSync, writeFileSync } = await import('node:fs');
  const f = fixture();
  try {
    const target = join(f.dir, 'unrelated.txt');
    writeFileSync(target, 'do not touch');
    symlinkSync(target, `${join(f.dir, 'notifications.json')}.lock`);
    await assert.rejects(f.store.enqueue({ ownerIdentityId: 'alice', event: event() }), /regular non-symlink file/);
  } finally { f.close(); }
});


test('serializes writes from independent Node.js processes to one outbox', async () => {
  const f = fixture();
  const modulePath = resolve('src/inactivity-notification-store.js');
  const childSource = `
    import { InactivityNotificationStore } from ${JSON.stringify(new URL(`file://${modulePath}`).href)};
    const store = new InactivityNotificationStore({ statePath: process.env.ZION_TEST_STATE_PATH, lockTimeoutMs: 60000 });
    for (let i = 0; i < 20; i++) {
      await store.enqueue({ ownerIdentityId: 'shared-owner', event: { type: 'pause-warning', message: process.env.ZION_WORKER_ID + ':' + i } });
    }
  `;
  const children = Array.from({ length: 3 }, (_, index) => spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(), env: { ...process.env, ZION_TEST_STATE_PATH: join(f.dir, 'notifications.json'), ZION_WORKER_ID: `worker-${index}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  }));
  try {
    const outcomes = await Promise.all(children.map(async child => {
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      const [code, signal] = await once(child, 'exit');
      return { code, signal, stderr };
    }));
    assert.deepEqual(outcomes.map(outcome => outcome.code), [0, 0, 0], outcomes.map(outcome => outcome.stderr).join('\n'));
    const records = await f.store.list('shared-owner', { limit: 100 });
    assert.equal(records.length, 60);
    assert.equal(new Set(records.map(record => record.id)).size, 60);
    assert.equal(new Set(records.map(record => record.message)).size, 60);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    f.close();
  }
});


test('failed atomic replacement rolls in-memory state back to last durable snapshot', async () => {
  const { mkdirSync, renameSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notifications-'));
  const statePath = join(dir, 'notifications.json');
  let sabotageNextSave = false;
  const store = new InactivityNotificationStore({ statePath, now: () => {
    if (sabotageNextSave) {
      sabotageNextSave = false;
      renameSync(statePath, join(dir, 'notifications.durable.json'));
      mkdirSync(statePath);
    }
    return '2026-10-09T12:00:00.000Z';
  }});
  try {
    const record = (await store.enqueue({ ownerIdentityId: 'alice', event: event() })).notification;
    const durableBefore = JSON.parse(readFileSync(statePath, 'utf8'));
    // Replace the state path only during the next mutation, after the exclusive lock
    // has loaded the prior durable state but before atomic rename is attempted.
    sabotageNextSave = true;
    await assert.rejects(store.markViewed('alice', record.id));
    const inMemory = store.state.notifications.find(item => item.id === record.id);
    assert.equal(inMemory.viewedAt, null, 'failed write must not leave a phantom viewedAt in memory');
    assert.equal(inMemory.deliveryStatus, 'pending');
    assert.equal(durableBefore.notifications[0].viewedAt, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('directory fsync failure reports uncertain durability without reverting visible committed state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-dir-fsync-'));
  const statePath = join(dir, 'notifications.json');
  let failSync = false;
  const store = new InactivityNotificationStore({ statePath, syncDirectory: directory => {
    if (failSync) throw Object.assign(new Error('simulated directory fsync failure'), { code: 'EIO' });
  } });
  try {
    failSync = true;
    await assert.rejects(
      store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'durability-uncertain-1' }),
      error => error.code === 'NOTIFICATION_STORE_DURABILITY_UNCONFIRMED' && error.commitVisible === true,
    );
    // A failed directory fsync occurs after rename: the canonical file and in-memory
    // snapshot must agree, and an idempotent retry must not create a duplicate.
    const reopened = new InactivityNotificationStore({ statePath, syncDirectory: () => {} });
    const saved = await reopened.list('alice');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].eventKey, 'durability-uncertain-1');
    const retry = await reopened.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'durability-uncertain-1' });
    assert.equal(retry.created, false);
    assert.equal((await reopened.list('alice')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('store startup cleans only abandoned UUID temp snapshots without following symlinks', async () => {
  const { writeFileSync, symlinkSync, existsSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-temp-recovery-'));
  const statePath = join(dir, 'notifications.json');
  const abandoned = `${statePath}.123e4567-e89b-42d3-a456-426614174000.tmp`;
  const symlinkTemp = `${statePath}.123e4567-e89b-42d3-a456-426614174001.tmp`;
  const unrelated = `${statePath}.keep.tmp`;
  const outside = join(dir, 'outside.txt');
  try {
    writeFileSync(abandoned, '{"partial":', { mode: 0o600 });
    writeFileSync(outside, 'must remain', { mode: 0o600 });
    symlinkSync(outside, symlinkTemp);
    writeFileSync(unrelated, 'do not touch', { mode: 0o600 });
    const store = new InactivityNotificationStore({ statePath });
    assert.deepEqual(await store.list('alice'), []);
    assert.equal(existsSync(abandoned), false, 'abandoned generated temp file should be removed');
    assert.equal(existsSync(symlinkTemp), false, 'generated temp symlink should be unlinked without following it');
    assert.equal(existsSync(unrelated), true, 'unrecognized similarly named files must be preserved');
    assert.equal(readFileSync(outside, 'utf8'), 'must remain');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('corrupt canonical state is reported and preserved along with temp recovery evidence', async () => {
  const { writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-corrupt-state-'));
  const statePath = join(dir, 'notifications.json');
  const corrupt = '{"version":1,"notifications":[';
  const temp = `${statePath}.123e4567-e89b-42d3-a456-426614174099.tmp`;
  try {
    writeFileSync(statePath, corrupt, { mode: 0o600 });
    writeFileSync(temp, '{"possible":"recovery evidence"}', { mode: 0o600 });
    assert.throws(() => new InactivityNotificationStore({ statePath }), error =>
      error.code === 'NOTIFICATION_STORE_CORRUPT' && error.statePath === statePath);
    assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'corrupt canonical data must not be overwritten');
    assert.equal(existsSync(temp), true, 'temporary evidence must not be cleaned if canonical state is corrupt');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects duplicate notification IDs and duplicate owner-scoped event keys without rewriting state', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-duplicate-state-'));
  const statePath = join(dir, 'notifications.json');
  const base = {
    id: 'same-id', ownerIdentityId: 'alice', type: 'pause-warning', message: 'Aviso', createdAt: '2026-10-09T12:00:00.000Z',
    eventKey: 'same-event', metadata: {}, deliveryStatus: 'pending', attempts: 0, lastAttemptAt: null,
    deliveredAt: null, deliveryReceipt: null, viewedAt: null,
  };
  try {
    for (const [records, expectedCode] of [
      [[{ ...base }, { ...base, id: 'different-id' }], 'NOTIFICATION_STORE_DUPLICATE_EVENT_KEY'],
      [[{ ...base }, { ...base, eventKey: 'other-event' }], 'NOTIFICATION_STORE_DUPLICATE_ID'],
    ]) {
      const original = `${JSON.stringify({ version: 1, notifications: records })}\n`;
      writeFileSync(statePath, original, { mode: 0o600 });
      assert.throws(() => new InactivityNotificationStore({ statePath }), error => error.code === expectedCode);
      assert.equal(readFileSync(statePath, 'utf8'), original, 'invalid state must remain untouched for diagnosis');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('keeps a validated last-good snapshot before replacing canonical state and never auto-restores it', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-last-good-'));
  const statePath = join(dir, 'notifications.json');
  const backupPath = `${statePath}.last-good`;
  try {
    const store = new InactivityNotificationStore({ statePath });
    const first = (await store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'before-backup' })).notification;
    await store.markViewed('alice', first.id);
    const previousSnapshot = JSON.parse(readFileSync(statePath, 'utf8'));
    await store.enqueue({ ownerIdentityId: 'alice', event: event('contribution-paused'), eventKey: 'after-backup' });
    assert.equal(existsSync(backupPath), true, 'a prior canonical snapshot should be retained');
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    assert.equal(backup.notifications.length, previousSnapshot.notifications.length);
    assert.equal(backup.notifications[0].eventKey, 'before-backup');
    assert.equal(backup.notifications[0].viewedAt, previousSnapshot.notifications[0].viewedAt);

    const corrupt = '{"version":1,"notifications":[';
    writeFileSync(statePath, corrupt, { mode: 0o600 });
    assert.throws(() => new InactivityNotificationStore({ statePath }), error => error.code === 'NOTIFICATION_STORE_CORRUPT');
    assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'recovery is never automatic over a corrupt canonical file');
    assert.equal(JSON.parse(readFileSync(backupPath, 'utf8')).notifications.length, 1, 'last-good snapshot remains available for explicit recovery');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read-only recovery inspection validates canonical and last-good snapshots and reports differences without mutation', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-recovery-inspection-'));
  const statePath = join(dir, 'notifications.json');
  const backupPath = `${statePath}.last-good`;
  try {
    const store = new InactivityNotificationStore({ statePath });
    const first = (await store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'recovery-first' })).notification;
    const backup = readFileSync(statePath, 'utf8');
    await store.enqueue({ ownerIdentityId: 'alice', event: event('contribution-paused'), eventKey: 'recovery-second' });
    writeFileSync(backupPath, backup, { mode: 0o600 });

    const report = InactivityNotificationStore.inspectRecovery({ statePath });
    assert.equal(report.status, 'both-valid');
    assert.equal(report.canonical.valid, true);
    assert.equal(report.lastGood.valid, true);
    assert.equal(report.canonical.recordCount, 2);
    assert.equal(report.lastGood.recordCount, 1);
    assert.equal(report.difference.canonicalOnlyCount, 1);
    assert.equal(report.difference.lastGoodOnlyCount, 0);
    assert.equal(report.difference.lastGoodOnlyIds.length, 0);
    assert.equal(report.automaticRestorePerformed, false);
    assert.equal(existsSync(statePath), true);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).notifications[0].id, first.id);

    const corrupt = '{"version":1,"notifications":[';
    writeFileSync(statePath, corrupt, { mode: 0o600 });
    const corruptReport = InactivityNotificationStore.inspectRecovery({ statePath });
    assert.equal(corruptReport.status, 'last-good-only-valid');
    assert.equal(corruptReport.canonical.valid, false);
    assert.equal(corruptReport.canonical.errorCode, 'NOTIFICATION_STORE_CORRUPT');
    assert.equal(corruptReport.lastGood.valid, true);
    assert.equal(corruptReport.difference, null, 'do not compare unvalidated records');
    assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'inspection must not rewrite corrupt canonical data');
    assert.equal(readFileSync(backupPath, 'utf8'), backup, 'inspection must not rewrite recovery snapshot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit recovery requires fresh hashes, preserves corrupt bytes, and restores only a validated last-good snapshot', async () => {
  const { readFileSync, writeFileSync, readdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-explicit-recovery-'));
  const statePath = join(dir, 'notifications.json');
  const backupPath = `${statePath}.last-good`;
  const digest = value => createHash('sha256').update(value).digest('hex');
  try {
    const store = new InactivityNotificationStore({ statePath });
    await store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'explicit-recovery' });
    const good = readFileSync(statePath, 'utf8');
    writeFileSync(backupPath, good, { mode: 0o600 });
    const corrupt = '{"version":1,"notifications":[';
    writeFileSync(statePath, corrupt, { mode: 0o600 });
    const inspection = InactivityNotificationStore.inspectRecovery({ statePath });
    await assert.rejects(InactivityNotificationStore.recoverLastGood({ statePath,
      expectedCanonicalSha256: inspection.canonical.sha256, expectedLastGoodSha256: inspection.lastGood.sha256 }),
    error => error.code === 'NOTIFICATION_RECOVERY_CONFIRMATION_REQUIRED');
    await assert.rejects(InactivityNotificationStore.recoverLastGood({ statePath, confirmRestore: true,
      expectedCanonicalSha256: '0'.repeat(64), expectedLastGoodSha256: inspection.lastGood.sha256 }),
    error => error.code === 'NOTIFICATION_RECOVERY_STALE_INSPECTION');
    assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'failed checks must not mutate canonical bytes');
    const result = await InactivityNotificationStore.recoverLastGood({ statePath, confirmRestore: true,
      expectedCanonicalSha256: inspection.canonical.sha256, expectedLastGoodSha256: inspection.lastGood.sha256 });
    assert.equal(result.status, 'restored');
    assert.equal(result.restoredRecordCount, 1);
    assert.equal(result.automaticRestorePerformed, false);
    assert.ok(result.preservedCorruptPath);
    assert.ok(result.auditPath);
    assert.equal(readFileSync(result.preservedCorruptPath, 'utf8'), corrupt, 'original corrupt bytes are preserved exactly');
    assert.equal(digest(readFileSync(statePath, 'utf8')), result.restoredSha256);
    const audit = JSON.parse(readFileSync(result.auditPath, 'utf8'));
    assert.equal(audit.operation, 'notification-store-recovery');
    assert.equal(audit.status, 'restored');
    assert.equal(audit.previousCanonicalSha256, inspection.canonical.sha256);
    assert.equal(audit.sourceSnapshotSha256, inspection.lastGood.sha256);
    assert.equal(audit.restoredSha256, result.restoredSha256);
    assert.equal(audit.restoredRecordCount, 1);
    assert.equal(JSON.stringify(audit).includes('Aviso de inatividade'), false, 'audit must not persist notification bodies');
    assert.equal(new InactivityNotificationStore({ statePath }).statePath, resolve(statePath));
    assert.ok(readdirSync(dir).some(name => name.startsWith('notifications.json.corrupt-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery reports visible commit when audit durability cannot be confirmed', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-recovery-audit-failure-'));
  const statePath = join(dir, 'notifications.json');
  let syncCalls = 0;
  try {
    const store = new InactivityNotificationStore({ statePath });
    await store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'audit-failure' });
    writeFileSync(`${statePath}.last-good`, readFileSync(statePath, 'utf8'), { mode: 0o600 });
    writeFileSync(statePath, '{corrupt', { mode: 0o600 });
    const inspection = InactivityNotificationStore.inspectRecovery({ statePath });
    await assert.rejects(InactivityNotificationStore.recoverLastGood({ statePath, confirmRestore: true,
      expectedCanonicalSha256: inspection.canonical.sha256, expectedLastGoodSha256: inspection.lastGood.sha256,
      syncDirectory: () => { syncCalls++; if (syncCalls === 3) throw new Error('simulated directory fsync failure'); } }),
    error => error.code === 'NOTIFICATION_RECOVERY_AUDIT_UNCONFIRMED' && error.commitVisible === true && Boolean(error.auditPath));
    assert.equal(new InactivityNotificationStore({ statePath }).statePath, resolve(statePath), 'restored canonical snapshot must be valid despite audit durability uncertainty');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit recovery refuses to overwrite a valid canonical state', async () => {
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-recovery-valid-refusal-'));
  const statePath = join(dir, 'notifications.json');
  try {
    const store = new InactivityNotificationStore({ statePath });
    await store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'valid-refusal-first' });
    await store.enqueue({ ownerIdentityId: 'alice', event: event('contribution-paused'), eventKey: 'valid-refusal-second' });
    const canonical = readFileSync(statePath, 'utf8');
    const inspection = InactivityNotificationStore.inspectRecovery({ statePath });
    await assert.rejects(InactivityNotificationStore.recoverLastGood({ statePath, confirmRestore: true,
      expectedCanonicalSha256: inspection.canonical.sha256, expectedLastGoodSha256: inspection.lastGood.sha256 }),
    error => error.code === 'NOTIFICATION_RECOVERY_CANONICAL_VALID');
    assert.equal(readFileSync(statePath, 'utf8'), canonical);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read-only recovery inspection rejects a symbolic link without following it', async () => {
  const { writeFileSync, symlinkSync, readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-recovery-symlink-'));
  const statePath = join(dir, 'notifications.json');
  const target = join(dir, 'important.txt');
  try {
    writeFileSync(target, 'keep untouched', { mode: 0o600 });
    symlinkSync(target, statePath);
    const report = InactivityNotificationStore.inspectRecovery({ statePath });
    assert.equal(report.canonical.valid, false);
    assert.equal(report.canonical.errorCode, 'NOTIFICATION_RECOVERY_UNSAFE_FILE_TYPE');
    assert.equal(readFileSync(target, 'utf8'), 'keep untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
