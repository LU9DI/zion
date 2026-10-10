import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryTrustRegistry } from '../src/notification-recovery-trust-registry.js';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { verifyNotificationRecoveryCheckpointChain } from '../src/notification-recovery-checkpoint-chain-verifier.js';

const now = Date.parse('2026-10-09T12:00:00.000Z');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-checkpoint-chain-'));
  const path = join(dir, 'registry.json');
  const initial = { schemaVersion: 1, revision: 0, keys: {}, events: [] };
  initial.stateSha256 = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
  writeFileSync(path, JSON.stringify(initial));
  const registry = new NotificationRecoveryTrustRegistry({ statePath: path });
  const keys = generateKeyPairSync('ed25519');
  const make = previousCheckpoint => NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: path, signerKeyId: 'anchor', privateKey: keys.privateKey, issuedAt: now, previousCheckpoint });
  return { path, registry, keys, make };
}

test('verifies signatures and a linked, advancing checkpoint history', () => {
  const ctx = setup();
  const first = ctx.make();
  ctx.registry.trustKey({ keyId: 'operator', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test-admin', reason: 'Advance registry for chain verification.', now: now + 1 });
  const second = ctx.make(first);
  assert.deepEqual(verifyNotificationRecoveryCheckpointChain({ checkpoints: [first, second], publicKey: ctx.keys.publicKey, expectedSignerKeyId: 'anchor', now }), {
    valid: true, code: 'verified', verifiedCount: 2, firstRevision: 0, lastRevision: 1,
    lastCheckpointSha256: NotificationRecoveryAuditAnchor.checkpointSha256(second),
  });
});

test('rejects an altered signature and identifies its history index', () => {
  const ctx = setup(); const first = ctx.make();
  const result = verifyNotificationRecoveryCheckpointChain({ checkpoints: [first, { ...first, registryRevision: 4 }], publicKey: ctx.keys.publicKey, now });
  assert.deepEqual(result, { valid: false, code: 'checkpoint-signature-invalid', index: 1, verifiedCount: 1 });
});

test('rejects a broken link even when both checkpoints have valid signatures', () => {
  const ctx = setup(); const first = ctx.make();
  ctx.registry.trustKey({ keyId: 'operator', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test-admin', reason: 'Advance registry for broken-chain test.', now: now + 1 });
  const alternateFirst = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: ctx.path, signerKeyId: 'anchor', privateKey: ctx.keys.privateKey, issuedAt: now + 1 });
  const second = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: ctx.path, signerKeyId: 'anchor', privateKey: ctx.keys.privateKey, issuedAt: now + 2, previousCheckpoint: alternateFirst });
  // Both signatures are valid, but the supplied history does not contain second's predecessor.
  const result = verifyNotificationRecoveryCheckpointChain({ checkpoints: [first, second], publicKey: ctx.keys.publicKey, now: now + 2 });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'checkpoint-chain-break');
  assert.equal(result.index, 1);
});

test('requires a null predecessor at the beginning unless a trusted checkpoint is supplied', () => {
  const ctx = setup(); const first = ctx.make();
  ctx.registry.trustKey({ keyId: 'operator', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test-admin', reason: 'Advance registry for anchored-chain test.', now: now + 1 });
  const second = ctx.make(first);
  assert.deepEqual(verifyNotificationRecoveryCheckpointChain({ checkpoints: [second], publicKey: ctx.keys.publicKey, now }), { valid: false, code: 'checkpoint-chain-start-missing', index: 0, verifiedCount: 0 });
  assert.equal(verifyNotificationRecoveryCheckpointChain({ checkpoints: [second], trustedCheckpoint: first, publicKey: ctx.keys.publicKey, now }).valid, true);
});

test('reports empty history and rejects duplicate or non-advancing states', () => {
  const ctx = setup(); const first = ctx.make();
  assert.equal(verifyNotificationRecoveryCheckpointChain({ checkpoints: [], publicKey: ctx.keys.publicKey, now }).code, 'history-empty');
  assert.equal(verifyNotificationRecoveryCheckpointChain({ checkpoints: [first, first], publicKey: ctx.keys.publicKey, now }).code, 'duplicate-or-nonadvancing-checkpoint');
});
