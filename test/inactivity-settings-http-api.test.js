import test from 'node:test';
import assert from 'node:assert/strict';
import { InactivitySettingsHttpApi } from '../src/inactivity-settings-http-api.js';
import { InactivitySettingsService, DEFAULT_INACTIVITY_SETTINGS } from '../src/inactivity-settings-service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const custom = { pauseWarningAtDays: 5, pauseAfterDays: 12, reductionWarningAtDays: 25, reduceAfterDays: 32, reductionPercent: 40 };
async function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-settings-api-'));
  const tokens = new Map([['token-a', { identityId: 'alice' }], ['token-b', { identityId: 'bob' }]]);
  const service = new InactivitySettingsService({ sessionAuthority: { authenticateToken: token => tokens.get(token) ?? null }, statePath: join(dir, 'state', 'settings.json') });
  const api = new InactivitySettingsHttpApi({ service, ...options });
  const address = await api.listen();
  const base = `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;
  return { dir, api, base };
}
const request = (base, path = '/api/v1/settings/inactivity', options = {}) => fetch(base + path, options);
const auth = token => ({ authorization: `Bearer ${token}` });

test('requires bearer session and returns secure no-store headers', async () => {
  const ctx = await setup();
  try {
    const denied = await request(ctx.base);
    assert.equal(denied.status, 401);
    const response = await request(ctx.base, undefined, { headers: auth('token-a') });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings, DEFAULT_INACTIVITY_SETTINGS);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('PUT persists settings for authenticated identity and ignores body identity fields only by rejecting extras', async () => {
  const ctx = await setup();
  try {
    const response = await request(ctx.base, undefined, { method: 'PUT', headers: { ...auth('token-a'), 'content-type': 'application/json' }, body: JSON.stringify(custom) });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings, custom);
    const bob = await request(ctx.base, undefined, { headers: auth('token-b') });
    assert.deepEqual((await bob.json()).settings, DEFAULT_INACTIVITY_SETTINGS);
    const spoof = await request(ctx.base, undefined, { method: 'PUT', headers: { ...auth('token-a'), 'content-type': 'application/json' }, body: JSON.stringify({ ...custom, identityId: 'bob' }) });
    assert.equal(spoof.status, 400);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('DELETE resets settings and rejects unsupported methods', async () => {
  const ctx = await setup();
  try {
    await request(ctx.base, undefined, { method: 'PUT', headers: { ...auth('token-a'), 'content-type': 'application/json' }, body: JSON.stringify(custom) });
    const reset = await request(ctx.base, undefined, { method: 'DELETE', headers: auth('token-a') });
    assert.equal(reset.status, 200);
    assert.deepEqual((await reset.json()).settings, DEFAULT_INACTIVITY_SETTINGS);
    assert.equal((await request(ctx.base, undefined, { method: 'POST', headers: auth('token-a') })).status, 405);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('rejects wrong content type, oversized payload and invalid JSON', async () => {
  const ctx = await setup();
  try {
    assert.equal((await request(ctx.base, undefined, { method: 'PUT', headers: auth('token-a'), body: '{}' })).status, 415);
    assert.equal((await request(ctx.base, undefined, { method: 'PUT', headers: { ...auth('token-a'), 'content-type': 'application/json' }, body: '{' })).status, 400);
    const large = await request(ctx.base, undefined, { method: 'PUT', headers: { ...auth('token-a'), 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(9000) }) });
    assert.equal(large.status, 413);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('refuses remote binding unless explicitly opted in', () => {
  assert.throws(() => new InactivitySettingsHttpApi({ service: { getSettings() {}, updateSettings() {}, resetSettings() {} }, host: '0.0.0.0' }), /Remote binding requires/);
});

test('rate limits requests per client address', async () => {
  const ctx = await setup({ maxRequestsPerMinute: 2 });
  try {
    assert.equal((await request(ctx.base, undefined, { headers: auth('bad') })).status, 401);
    assert.equal((await request(ctx.base, undefined, { headers: auth('bad') })).status, 401);
    assert.equal((await request(ctx.base, undefined, { headers: auth('token-a') })).status, 429);
  } finally { await ctx.api.close(); rmSync(ctx.dir, { recursive: true, force: true }); }
});
