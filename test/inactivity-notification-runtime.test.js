import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InactivityResourcePolicy } from '../src/inactivity-resource-policy.js';
import { createInactivityNotificationRuntime } from '../src/inactivity-notification-runtime.js';

const DAY = 24 * 60 * 60 * 1000;

test('runtime wires policy event through durable outbox, verified delivery, and authenticated API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-runtime-'));
  const base = Date.now();
  const runtime = createInactivityNotificationRuntime({
    statePath: join(dir, 'notifications.json'),
    ownerIdentityId: 'alice',
    sessionAuthority: { authenticateToken: token => token === 'alice-token' ? { identityId: 'alice' } : null },
    listOwnerIdentityIds: async () => ['alice'],
    deliver: async notification => ({ delivered: true, receipt: `provider-${notification.id}` }),
    now: () => base,
  });
  const policy = new InactivityResourcePolicy({
    statePath: join(dir, 'policy.json'), now: () => base, notify: runtime.notify,
    options: { warningBeforePauseMs: DAY, pauseAfterMs: 2 * DAY, reductionNoticeBeforeMs: DAY, reduceAfterMs: 3 * DAY },
    getCapacity: async () => 100, getUsage: async () => 10,
  });
  try {
    const evaluated = await policy.evaluate(base + DAY);
    assert.equal(evaluated.events[0].type, 'pause-warning');
    const pending = await runtime.store.list('alice', { status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].deliveryStatus, 'pending');

    const address = await runtime.api.listen();
    const delivered = await runtime.deliveryWorker.runOnce();
    assert.equal(delivered.delivered, 1);

    const response = await fetch(`http://${address.host}:${address.port}/api/v1/notifications/inactivity`, {
      headers: { authorization: 'Bearer alice-token' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.notifications.length, 1);
    assert.equal(body.notifications[0].deliveryStatus, 'delivered');
    assert.equal('ownerIdentityId' in body.notifications[0], false);
    assert.equal('deliveryReceipt' in body.notifications[0], false);

    const id = body.notifications[0].id;
    const viewed = await fetch(`http://${address.host}:${address.port}/api/v1/notifications/inactivity/${id}/viewed`, {
      method: 'POST', headers: { authorization: 'Bearer alice-token' },
    });
    assert.equal(viewed.status, 200);
    const viewedBody = await viewed.json();
    assert.equal(typeof viewedBody.notification.viewedAt, 'string');
    assert.equal((await runtime.store.list('alice'))[0].viewedAt, viewedBody.notification.viewedAt);
  } finally {
    await runtime.deliveryWorker.stop();
    await runtime.api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime refuses an absent owner identity instead of silently misattributing events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-notification-runtime-'));
  const runtime = createInactivityNotificationRuntime({
    statePath: join(dir, 'notifications.json'), ownerIdentityId: null,
    sessionAuthority: { authenticateToken: () => null }, listOwnerIdentityIds: async () => [],
    deliver: async () => ({ delivered: false }),
  });
  try {
    await assert.rejects(runtime.notify({ type: 'pause-warning', message: 'Aviso' }), /owner identity is required/u);
  } finally {
    await runtime.deliveryWorker.stop();
    await runtime.api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
