import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClient() {
  const context = { AbortController, setTimeout, clearTimeout, URL, console };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL('../cloud/inactivity-notifications-api-client.js', import.meta.url), 'utf8'), context);
  return context.ZionInactivityNotificationsApiClient;
}

test('notification client scopes calls to bearer session and avoids browser credentials', async () => {
  let request;
  const client = loadClient().create({ getAccessToken: () => 'session-token', fetchImpl: async (url, init) => {
    request = { url, init };
    return { ok: true, status: 200, json: async () => ({ ok: true, notifications: [] }) };
  }, baseUrl: 'https://api.example.test/' });
  const result = await client.list({ status: 'pending', limit: 25 });
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://api.example.test/api/v1/notifications/inactivity?status=pending&limit=25');
  assert.equal(request.init.headers.authorization, 'Bearer session-token');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
});

test('notification client validates filters, limits and UUID before network access', async () => {
  let calls = 0;
  const client = loadClient().create({ getAccessToken: () => 't', fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ ok: true, notifications: [] }) }; } });
  assert.throws(() => client.list({ status: 'secret', limit: 2 }), /Parâmetros/);
  assert.throws(() => client.list({ limit: 501 }), /Parâmetros/);
  assert.throws(() => client.markViewed('not-a-uuid'), /ID de notificação/);
  assert.equal(calls, 0);
  await client.markViewed('5f4dcc3b-5aa7-4b8a-9b9b-1a2b3c4d5e6f');
  assert.equal(calls, 1);
});

test('notification client fails closed without a session and maps server failures safely', async () => {
  const client = loadClient().create({ getAccessToken: () => null, fetchImpl: async () => { throw new Error('should not fetch'); } });
  await assert.rejects(client.list(), error => error.code === 'AUTH_REQUIRED');
  const unavailable = loadClient().create({ getAccessToken: () => 't', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'internal_error' }) }) });
  await assert.rejects(unavailable.list(), error => error.status === 503 && /indisponível/.test(error.message));
});
