import test from 'node:test';
import assert from 'node:assert/strict';
import { ContributionAuditScheduler } from '../src/contribution-audit-scheduler.js';

const policy = (ttl = 10_000) => ({
  contributionTtlMs: ttl, revoked: 0,
  revokeVerifiedContribution() { this.revoked++; },
});

test('runs one bounded audit and publishes the successful report', async () => {
  const p = policy(); let calls = 0; let observed;
  const scheduler = new ContributionAuditScheduler({
    storageService: { async refreshVerifiedContribution(receivedPolicy, options) { calls++; assert.equal(receivedPolicy, p); assert.deepEqual(options, { maxEntries: 25, batchSize: 128 }); return { verifiedBytes: 123, personalQuotaBytes: 61 }; } },
    fairSharePolicy: p, intervalMs: 1000, maxEntries: 25, onResult: result => { observed = result; },
  });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, true); assert.equal(result.verifiedBytes, 123); assert.equal(calls, 1); assert.equal(observed, result); assert.equal(p.revoked, 0);
  scheduler.close();
});

test('coalesces overlapping audit requests instead of scanning the disk concurrently', async () => {
  let release; let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const scheduler = new ContributionAuditScheduler({ storageService: { async refreshVerifiedContribution() { calls++; await pending; return { verifiedBytes: 0 }; } }, fairSharePolicy: policy(), intervalMs: 1000 });
  const a = scheduler.runOnce(); const b = scheduler.runOnce();
  assert.equal(calls, 1); release(); assert.equal(await a, await b); assert.equal(calls, 1); scheduler.close();
});

test('revokes contribution credit when an audit fails and reports a closed failure', async () => {
  const p = policy();
  const scheduler = new ContributionAuditScheduler({ storageService: { async refreshVerifiedContribution() { throw new Error('corrupt inventory'); } }, fairSharePolicy: p, intervalMs: 1000 });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, false); assert.equal(result.reason, 'audit-failed'); assert.match(result.message, /corrupt inventory/); assert.equal(p.revoked, 1); scheduler.close();
});

test('rejects an audit interval that could let evidence expire before the next run', () => {
  assert.throws(() => new ContributionAuditScheduler({ storageService: { refreshVerifiedContribution() {} }, fairSharePolicy: policy(5000), intervalMs: 5000 }), /shorter than the contribution evidence TTL/);
});

test('stop is idempotent and close prevents further audits', async () => {
  let calls = 0;
  const scheduler = new ContributionAuditScheduler({ storageService: { async refreshVerifiedContribution() { calls++; return { verifiedBytes: 0 }; } }, fairSharePolicy: policy(), intervalMs: 1000 });
  scheduler.start({ runImmediately: false }); scheduler.stop(); scheduler.stop(); scheduler.close();
  assert.deepEqual(await scheduler.runOnce(), { ok: false, reason: 'scheduler-closed' }); assert.equal(calls, 0);
});

test('resource-aware gate skips audit when telemetry is unavailable without revoking fresh credit', async () => {
  const p = policy(); let calls = 0;
  const scheduler = new ContributionAuditScheduler({
    storageService: { async refreshVerifiedContribution() { calls++; return { verifiedBytes: 100 }; } },
    fairSharePolicy: p, intervalMs: 1000,
    adaptiveController: { evaluate(telemetry) { return { enabled: telemetry?.safe === true, concurrentJobs: telemetry?.safe ? 1 : 0, reasons: telemetry?.safe ? [] : ['telemetry-unavailable'] }; } },
    getTelemetry: async () => null,
  });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, false); assert.equal(result.reason, 'resources-not-available');
  assert.equal(calls, 0); assert.equal(p.revoked, 0); scheduler.close();
});

test('resource-aware gate runs audit only after a positive adaptive budget', async () => {
  let calls = 0;
  const scheduler = new ContributionAuditScheduler({
    storageService: { async refreshVerifiedContribution() { calls++; return { verifiedBytes: 100 }; } },
    fairSharePolicy: policy(), intervalMs: 1000,
    adaptiveController: { evaluate(telemetry) { return { enabled: telemetry.safe, concurrentJobs: telemetry.safe ? 1 : 0, reasons: [] }; } },
    getTelemetry: async () => ({ safe: true }),
  });
  const result = await scheduler.runOnce();
  assert.equal(result.ok, true); assert.equal(calls, 1); scheduler.close();
});

test('rejects an invalid audit batch size', () => {
  assert.throws(() => new ContributionAuditScheduler({ storageService: { refreshVerifiedContribution() {} }, fairSharePolicy: policy(), intervalMs: 1000, batchSize: 5000 }), /Invalid contribution audit scheduler configuration/);
});

test('resource-aware configuration requires controller and telemetry provider together', () => {
  assert.throws(() => new ContributionAuditScheduler({ storageService: { refreshVerifiedContribution() {} }, fairSharePolicy: policy(), intervalMs: 1000, adaptiveController: { evaluate() {} } }), /Invalid contribution audit scheduler configuration/);
});
