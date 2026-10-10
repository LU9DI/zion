import test from 'node:test';
import assert from 'node:assert/strict';
import { InactivityPolicySettingsBridge } from '../src/inactivity-policy-settings-bridge.js';
import { InactivityResourcePolicy } from '../src/inactivity-resource-policy.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const settings = Object.freeze({ pauseWarningAtDays: 3, pauseAfterDays: 9, reductionWarningAtDays: 12, reduceAfterDays: 20, reductionPercent: 40 });
function policy() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-live-settings-'));
  const instance = new InactivityResourcePolicy({ statePath: join(dir, 'state.json'), options: {
    warningBeforePauseMs: 7 * 86400000, pauseAfterMs: 14 * 86400000,
    reductionNoticeBeforeMs: 7 * 86400000, reduceAfterMs: 37 * 86400000, reductionFactor: 0.5,
  }, getCapacity: async () => 100, getUsage: async () => 10 });
  return { instance, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('applies owner account settings to the live policy and confirms application', async () => {
  const p = policy();
  const bridge = new InactivityPolicySettingsBridge({ ownerIdentityId: 'owner-1', getAccessToken: async () => 'session-token',
    settingsService: { getSettings: async token => { assert.equal(token, 'session-token'); return { identityId: 'owner-1', settings, source: 'account' }; } }, policy: p.instance });
  const result = await bridge.applySavedSettings();
  assert.equal(result.ok, true);
  assert.equal(result.appliedToNode, true);
  assert.equal(result.options.pauseAfterMs, 9 * 86400000);
  assert.equal(result.options.warningBeforePauseMs, 6 * 86400000);
  assert.equal(result.options.reductionFactor, 0.6);
  assert.equal(bridge.snapshot().applied.identityId, 'owner-1');
  p.cleanup();
});

test('refuses settings belonging to a different identity and leaves policy unchanged', async () => {
  const p = policy(); const before = p.instance.snapshot().options;
  const bridge = new InactivityPolicySettingsBridge({ ownerIdentityId: 'owner-1', getAccessToken: () => 'other-session',
    settingsService: { getSettings: async () => ({ identityId: 'owner-2', settings, source: 'account' }) }, policy: p.instance });
  const result = await bridge.applySavedSettings();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'OWNER_MISMATCH');
  assert.deepEqual(p.instance.snapshot().options, before);
  p.cleanup();
});

test('missing session fails closed and does not mutate live policy', async () => {
  const p = policy(); const before = p.instance.snapshot().options;
  const bridge = new InactivityPolicySettingsBridge({ ownerIdentityId: 'owner-1', getAccessToken: () => null,
    settingsService: { getSettings: async () => { throw new Error('must not be called'); } }, policy: p.instance });
  const result = await bridge.applySavedSettings();
  assert.equal(result.error.code, 'AUTH_REQUIRED');
  assert.deepEqual(p.instance.snapshot().options, before);
  p.cleanup();
});

test('rejects malformed service settings without replacing active policy options', async () => {
  const p = policy(); const before = p.instance.snapshot().options;
  const bridge = new InactivityPolicySettingsBridge({ ownerIdentityId: 'owner-1', getAccessToken: () => 'token',
    settingsService: { getSettings: async () => ({ identityId: 'owner-1', settings: { ...settings, reductionPercent: 100 } }) }, policy: p.instance });
  const result = await bridge.applySavedSettings();
  assert.equal(result.ok, false);
  assert.deepEqual(p.instance.snapshot().options, before);
  p.cleanup();
});

test('rejects invalid bridge configuration', () => {
  assert.throws(() => new InactivityPolicySettingsBridge({}), /Invalid inactivity policy settings bridge/);
});
