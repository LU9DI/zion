import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InactivitySettingsService, DEFAULT_INACTIVITY_SETTINGS, inactivitySettingsToPolicyOptions } from '../src/inactivity-settings-service.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-inactivity-settings-'));
  const tokens = new Map([['token-user-a', { identityId: 'user-a' }], ['token-user-b', { identityId: 'user-b' }]]);
  const service = new InactivitySettingsService({ sessionAuthority: { authenticateToken: token => tokens.get(token) || null }, statePath: join(dir, 'private', 'settings.json'), now: () => 1_800_000_000_000 });
  return { dir, service };
}
const custom = { pauseWarningAtDays: 5, pauseAfterDays: 12, reductionWarningAtDays: 25, reduceAfterDays: 32, reductionPercent: 40 };

test('requires an authenticated session for reads and writes', async () => {
  const { dir, service } = setup();
  try {
    await assert.rejects(service.getSettings('unknown'), error => error.code === 'UNAUTHENTICATED' && error.status === 401);
    await assert.rejects(service.updateSettings('unknown', custom), error => error.code === 'UNAUTHENTICATED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stores settings per identity and persists them across service instances', async () => {
  const { dir, service } = setup();
  try {
    assert.deepEqual((await service.getSettings('token-user-a')).settings, DEFAULT_INACTIVITY_SETTINGS);
    const updated = await service.updateSettings('token-user-a', custom);
    assert.equal(updated.appliedToNode, false);
    assert.deepEqual(updated.settings, custom);
    assert.deepEqual((await service.getSettings('token-user-b')).settings, DEFAULT_INACTIVITY_SETTINGS);
    const restarted = new InactivitySettingsService({ sessionAuthority: { authenticateToken: token => token === 'token-user-a' ? { identityId: 'user-a' } : null }, statePath: join(dir, 'private', 'settings.json') });
    assert.deepEqual((await restarted.getSettings('token-user-a')).settings, custom);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects invalid thresholds, unknown fields, and unsafe reduction percentages', async () => {
  const { dir, service } = setup();
  try {
    await assert.rejects(service.updateSettings('token-user-a', { ...custom, pauseWarningAtDays: 12 }), /outside allowed limits/);
    await assert.rejects(service.updateSettings('token-user-a', { ...custom, extra: true }), /Unknown inactivity setting/);
    await assert.rejects(service.updateSettings('token-user-a', { ...custom, reductionPercent: 99 }), /outside allowed limits/);
    await assert.rejects(service.updateSettings('token-user-a', { ...custom, reduceAfterDays: 20 }), /outside allowed limits/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serializes concurrent updates and reset is scoped to the authenticated identity', async () => {
  const { dir, service } = setup();
  try {
    await Promise.all([
      service.updateSettings('token-user-a', custom),
      service.updateSettings('token-user-b', { ...custom, reductionPercent: 25 }),
    ]);
    await service.resetSettings('token-user-a');
    assert.deepEqual((await service.getSettings('token-user-a')).settings, DEFAULT_INACTIVITY_SETTINGS);
    assert.equal((await service.getSettings('token-user-b')).settings.reductionPercent, 25);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('converts validated UI settings into policy durations without claiming application', () => {
  const options = inactivitySettingsToPolicyOptions(custom);
  assert.equal(options.pauseAfterMs, 12 * 86_400_000);
  assert.equal(options.warningBeforePauseMs, 7 * 86_400_000);
  assert.equal(options.reduceAfterMs, 32 * 86_400_000);
  assert.equal(options.reductionNoticeBeforeMs, 7 * 86_400_000);
  assert.equal(options.reductionFactor, 0.6);
});
