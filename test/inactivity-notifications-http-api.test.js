import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InactivityNotificationStore } from '../src/inactivity-notification-store.js';
import { InactivityNotificationsHttpApi } from '../src/inactivity-notifications-http-api.js';

async function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-notifications-api-'));
  const tokens = new Map([['token-a', { identityId: 'alice' }], ['token-b', { identityId: 'bob' }]]);
  const store = new InactivityNotificationStore({ statePath: join(dir, 'notifications.json') });
  const api = new InactivityNotificationsHttpApi({ store, sessionAuthority: { authenticateToken: token => tokens.get(token) ?? null }, ...options });
  const address = await api.listen();
  const base = `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;
  return { dir, store, api, base };
}
const auth = token => ({ authorization: `Bearer ${token}` });
const request = (base, path = '/api/v1/notifications/inactivity', options = {}) => fetch(base + (path.startsWith('?') ? '/api/v1/notifications/inactivity' + path : path), options);
const event = (type = 'pause-warning') => ({ type, message: 'Sua contribuição será pausada por inatividade.', idleMs: 12345 });

test('requires authentication and lists only notifications belonging to authenticated identity', async () => {
  const ctx = await setup();
  try {
    await ctx.store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'alice-1' });
    await ctx.store.enqueue({ ownerIdentityId: 'bob', event: event(), eventKey: 'bob-1' });
    assert.equal((await request(ctx.base)).status, 401);
    const response = await request(ctx.base, undefined, { headers: auth('token-a') });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.notifications.length, 1);
    assert.equal(body.notifications[0].message, event().message);
    assert.equal('ownerIdentityId' in body.notifications[0], false);
    assert.equal('eventKey' in body.notifications[0], false);
    assert.equal('deliveryReceipt' in body.notifications[0], false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('filters status and validates bounded query parameters', async () => {
  const ctx = await setup();
  try {
    const pending = await ctx.store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'p' });
    const delivered = await ctx.store.enqueue({ ownerIdentityId: 'alice', event: event('contribution-paused'), eventKey: 'd' });
    await ctx.store.confirmDelivered('alice', delivered.notification.id, 'provider-receipt');
    const response = await request(ctx.base, '?status=pending&limit=10', { headers: auth('token-a') });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).notifications.map(n => n.id), [pending.notification.id]);
    assert.equal((await request(ctx.base, '?status=any', { headers: auth('token-a') })).status, 400);
    assert.equal((await request(ctx.base, '?limit=501', { headers: auth('token-a') })).status, 400);
    assert.equal((await request(ctx.base, '?owner=alice', { headers: auth('token-a') })).status, 400);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('marks a notification viewed for its owner and prevents cross-owner access', async () => {
  const ctx = await setup();
  try {
    const item = await ctx.store.enqueue({ ownerIdentityId: 'alice', event: event(), eventKey: 'only-alice' });
    const path = `/api/v1/notifications/inactivity/${item.notification.id}/viewed`;
    assert.equal((await request(ctx.base, path, { method: 'POST', headers: auth('token-b') })).status, 404);
    const response = await request(ctx.base, path, { method: 'POST', headers: auth('token-a') });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.notification.viewedAt, 'string');
    assert.equal((await request(ctx.base, path, { method: 'GET', headers: auth('token-a') })).status, 405);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('does not expose an HTTP route to forge delivery confirmation and rate limits requests', async () => {
  const ctx = await setup({ maxRequestsPerMinute: 2 });
  try {
    assert.equal((await request(ctx.base, '/api/v1/notifications/inactivity/00000000-0000-4000-8000-000000000000/delivered', { method: 'POST', headers: auth('token-a') })).status, 404);
    assert.equal((await request(ctx.base, undefined, { method: 'PUT', headers: auth('token-a') })).status, 405);
    assert.equal((await request(ctx.base, undefined, { headers: auth('token-a') })).status, 200);
    assert.equal((await request(ctx.base, undefined, { headers: auth('token-a') })).status, 200);
    assert.equal((await request(ctx.base, undefined, { headers: auth('token-a') })).status, 429);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('requires safe local binding unless a trusted ingress is explicitly configured', () => {
  assert.throws(() => new InactivityNotificationsHttpApi({ store: { list() {}, markViewed() {} }, sessionAuthority: { authenticateToken() {} }, host: '0.0.0.0' }), /Remote binding requires/);
});
