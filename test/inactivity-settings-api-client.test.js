import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClient() {
  const context = { AbortController, setTimeout, clearTimeout, URL, console };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL('../cloud/inactivity-settings-api-client.js', import.meta.url), 'utf8'), context);
  return context.ZionInactivitySettingsApiClient;
}
const settings = { pauseWarningAtDays: 7, pauseAfterDays: 14, reductionWarningAtDays: 30, reduceAfterDays: 37, reductionPercent: 50 };

test('API client sends bearer token, no-store and never includes credentials', async () => {
  const clientApi = loadClient(); let request;
  const client = clientApi.create({ getAccessToken: async () => 'secret-token', fetchImpl: async (url, init) => {
    request = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true, settings, source: 'account', appliedToNode: false }) };
  } });
  const result = await client.get();
  assert.equal(result.ok, true);
  assert.equal(request.url, '/api/v1/settings/inactivity');
  assert.equal(request.init.headers.authorization, 'Bearer secret-token');
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
});

test('PUT sends only supplied settings and DELETE sends no body', async () => {
  const calls = [];
  const client = loadClient().create({ getAccessToken: () => 't', fetchImpl: async (_url, init) => {
    calls.push(init); return { ok: true, status: 200, json: async () => ({ ok: true, settings, appliedToNode: false }) };
  } });
  await client.put(settings); await client.reset();
  assert.equal(calls[0].method, 'PUT'); assert.equal(JSON.parse(calls[0].body).reductionPercent, 50);
  assert.equal(calls[1].method, 'DELETE'); assert.equal('body' in calls[1], false);
});

test('rejects missing auth token without making a request', async () => {
  let called = false;
  const client = loadClient().create({ getAccessToken: async () => null, fetchImpl: async () => { called = true; } });
  await assert.rejects(client.get(), error => error.code === 'AUTH_REQUIRED');
  assert.equal(called, false);
});

test('surfaces HTTP auth and rate limit errors as safe user messages', async () => {
  for (const [status, code, message] of [[401, 'unauthorized', /Sessão expirada/], [429, 'rate_limit_exceeded', /Muitas solicitações/]]) {
    const client = loadClient().create({ getAccessToken: () => 't', fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: code }) }) });
    await assert.rejects(client.get(), error => error.status === status && message.test(error.message));
  }
});

test('validates configuration and bounds timeout', () => {
  const api = loadClient();
  assert.throws(() => api.create({}), /required/);
  assert.throws(() => api.create({ getAccessToken() {}, fetchImpl() {}, timeoutMs: 11000 }), /timeoutMs/);
});
