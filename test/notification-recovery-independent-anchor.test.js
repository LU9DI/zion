import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryTrustRegistry } from '../src/notification-recovery-trust-registry.js';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { NotificationRecoveryIndependentAnchor, MemoryNotificationAnchorAdapter } from '../src/notification-recovery-independent-anchor.js';

const issuedAt = Date.parse('2026-10-09T12:00:00.000Z');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-independent-anchor-'));
  const path = join(dir, 'registry.json');
  const initial = { schemaVersion: 1, revision: 0, keys: {}, events: [] };
  initial.stateSha256 = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
  writeFileSync(path, JSON.stringify(initial));
  const registry = new NotificationRecoveryTrustRegistry({ statePath: path });
  const keys = generateKeyPairSync('ed25519');
  const adapter = new MemoryNotificationAnchorAdapter();
  const client = new NotificationRecoveryIndependentAnchor({ adapter, publicKey: keys.publicKey, expectedSignerKeyId: 'anchor', now: () => issuedAt });
  const make = previousCheckpoint => NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: path, signerKeyId: 'anchor', privateKey: keys.privateKey, issuedAt, previousCheckpoint });
  return { registry, keys, adapter, client, make };
}

test('publishes a signed checkpoint, verifies read-back, and makes identical publish idempotent', async () => {
  const ctx = setup(); const first = ctx.make();
  assert.deepEqual(await ctx.client.publish(first), { published: true, idempotent: false, checkpointSha256: NotificationRecoveryAuditAnchor.checkpointSha256(first) });
  assert.equal((await ctx.client.publish(first)).idempotent, true);
  assert.equal((await ctx.client.verifyLatest()).valid, true);
});

test('rejects forged checkpoint before publishing', async () => {
  const ctx = setup(); const checkpoint = ctx.make();
  await assert.rejects(ctx.client.publish({ ...checkpoint, registryRevision: 8 }), e => e.code === 'NOTIFICATION_ANCHOR_CHECKPOINT_UNTRUSTED');
  assert.equal(await ctx.adapter.getLatest(), null);
});

test('refuses rollback/fork and accepts only a linked revision advance', async () => {
  const ctx = setup(); const first = ctx.make(); await ctx.client.publish(first);
  ctx.registry.trustKey({ keyId: 'operator', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test-admin', reason: 'Test advancing trusted registry.', now: issuedAt });
  const second = ctx.make(first); await ctx.client.publish(second);
  assert.equal((await ctx.client.verifyLatest({ trustedCheckpoint: first })).valid, true);
  await assert.rejects(ctx.client.publish(first), e => e.code === 'NOTIFICATION_ANCHOR_CONFLICT');
});

test('reports destination outages without treating them as an empty trusted anchor', async () => {
  const ctx = setup(); ctx.adapter.setAvailable(false);
  assert.deepEqual(await ctx.client.verifyLatest(), { valid: false, code: 'anchor-unavailable' });
  await assert.rejects(ctx.client.publish(ctx.make()), e => e.code === 'NOTIFICATION_ANCHOR_UNAVAILABLE');
});

test('detects modified externally stored checkpoint during verification', async () => {
  const ctx = setup(); const stored = ctx.make();
  const tamperedAdapter = { async getLatest() { return { ...stored, registryRevision: stored.registryRevision + 1 }; }, async publish() { return { stored: true }; } };
  const verifier = new NotificationRecoveryIndependentAnchor({ adapter: tamperedAdapter, publicKey: ctx.keys.publicKey, expectedSignerKeyId: 'anchor', now: () => issuedAt });
  assert.deepEqual(await verifier.verifyLatest(), { valid: false, code: 'checkpoint-signature-invalid' });
});
