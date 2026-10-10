import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryTrustRegistry } from '../src/notification-recovery-trust-registry.js';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';

const now = Date.parse('2026-10-09T12:00:00.000Z');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zion-audit-anchor-'));
  const registryPath = join(root, 'trust', 'registry.json');
  mkdirSync(join(root, 'trust'), { recursive: true });
  const empty = { schemaVersion: 1, revision: 0, keys: {}, events: [] };
  empty.stateSha256 = createHash('sha256').update(JSON.stringify(empty)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(empty));
  const registry = new NotificationRecoveryTrustRegistry({ statePath: registryPath });
  const pair = generateKeyPairSync('ed25519');
  return { root, registryPath, registry, publicKey: pair.publicKey, privateKey: pair.privateKey };
}
const create = (ctx, previousCheckpoint) => NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: ctx.registryPath, signerKeyId: 'anchor-key', privateKey: ctx.privateKey, issuedAt: now, previousCheckpoint });

test('creates and verifies a signed checkpoint bound to a valid registry revision', () => {
  const ctx = setup();
  ctx.registry.trustKey({ keyId: 'operator-a', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test-admin', reason: 'Register an operator for anchor test.', now });
  const checkpoint = create(ctx);
  assert.equal(checkpoint.registryRevision, 1);
  assert.equal(NotificationRecoveryAuditAnchor.verifyCheckpoint(checkpoint, { publicKey: ctx.publicKey, expectedSignerKeyId: 'anchor-key', now }).valid, true);
  assert.equal(NotificationRecoveryAuditAnchor.verifyCheckpoint(checkpoint, { publicKey: ctx.publicKey, expectedSignerKeyId: 'other-key', now }).code, 'unexpected-signer');
});

test('rejects modified signatures, expired checkpoints, and invalid registry digest', () => {
  const ctx = setup();
  const checkpoint = create(ctx);
  assert.equal(NotificationRecoveryAuditAnchor.verifyCheckpoint({ ...checkpoint, registryRevision: 99 }, { publicKey: ctx.publicKey, now }).code, 'signature-invalid');
  assert.equal(NotificationRecoveryAuditAnchor.verifyCheckpoint(checkpoint, { publicKey: ctx.publicKey, now: now + 10000, maxAgeMs: 100 }).code, 'checkpoint-too-old');
  writeFileSync(ctx.registryPath, JSON.stringify({ schemaVersion: 1, revision: 9, keys: {}, events: [], stateSha256: '0'.repeat(64) }));
  assert.throws(() => create(ctx), error => error.code === 'NOTIFICATION_AUDIT_ANCHOR_INVALID_REGISTRY');
});

test('detects rollback, same-revision forks, and broken checkpoint ancestry', () => {
  const ctx = setup();
  const first = create(ctx);
  ctx.registry.trustKey({ keyId: 'operator-b', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test-admin', reason: 'Advance registry for second checkpoint.', now: now + 1 });
  const second = create(ctx, first);
  assert.deepEqual(NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: first, observed: second }), { consistent: true, code: 'advanced' });
  assert.equal(NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: second, observed: first }).code, 'rollback-detected');
  const fork = { ...first, registryStateSha256: 'a'.repeat(64) };
  assert.equal(NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: first, observed: fork }).code, 'same-revision-fork');
  assert.equal(NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: first, observed: { ...second, previousCheckpointSha256: 'b'.repeat(64) } }).code, 'checkpoint-chain-break');
});

test('rejects symbolic-link registry input', async () => {
  const ctx = setup();
  const { symlinkSync } = await import('node:fs');
  const link = join(ctx.root, 'registry-link.json');
  symlinkSync(ctx.registryPath, link);
  assert.throws(() => NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: link, signerKeyId: 'anchor-key', privateKey: ctx.privateKey, issuedAt: now }), error => error.code === 'NOTIFICATION_AUDIT_ANCHOR_UNSAFE_REGISTRY');
});
