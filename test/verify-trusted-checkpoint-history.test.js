import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryTrustRegistry } from '../src/notification-recovery-trust-registry.js';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { createNotificationRecoveryAnchorKeyTransition } from '../src/notification-recovery-anchor-key-rotation.js';
import { createNotificationRecoveryAnchorKeyRevocation } from '../src/notification-recovery-anchor-key-revocation.js';
import { verifyTrustedCheckpointHistory } from '../scripts/verify-trusted-checkpoint-history.js';

const now = Date.parse('2026-10-09T12:00:00.000Z');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-trusted-history-'));
  const path = join(dir, 'registry.json');
  const initial = { schemaVersion: 1, revision: 0, keys: {}, events: [] };
  initial.stateSha256 = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
  writeFileSync(path, JSON.stringify(initial));
  const registry = new NotificationRecoveryTrustRegistry({ statePath: path });
  const old = generateKeyPairSync('ed25519'); const next = generateKeyPairSync('ed25519'); const authority = generateKeyPairSync('ed25519');
  const pem = old.publicKey.export({ type: 'spki', format: 'pem' });
  const policy = { schemaVersion: 1, signerKeyId: 'anchor-1', publicKeyPem: pem, publicKeySha256: createHash('sha256').update(old.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  const first = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: path, signerKeyId: 'anchor-1', privateKey: old.privateKey, issuedAt: now });
  registry.trustKey({ keyId: 'operator', publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), actor: 'test', reason: 'Advance registry for chain test.', now: now + 1 });
  const transition = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'anchor-1', signerKeyId: 'anchor-2', publicKey: next.publicKey, previousPrivateKey: old.privateKey, issuedAt: now + 2 });
  const second = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: path, signerKeyId: 'anchor-2', privateKey: next.privateKey, issuedAt: now + 3, previousCheckpoint: first });
  return { dir, path, registry, old, next, authority, policy, first, second, transition };
}
const opts = f => ({ checkpoints: [f.first, f.second], trustPolicy: f.policy, transitions: [f.transition], revocations: [], revocationAuthorityPublicKey: f.authority.publicKey, now: now + 10 });

test('verifies full linked history using out-of-band trust and a signed key rotation', t => {
  const f = setup(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const result = verifyTrustedCheckpointHistory(opts(f));
  assert.equal(result.valid, true); assert.equal(result.verifiedCount, 2); assert.equal(result.activeSignerKeyId, 'anchor-2'); assert.equal(result.rotationCount, 1);
});

test('rejects a truncated or altered checkpoint chain', t => {
  const f = setup(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const broken = verifyTrustedCheckpointHistory({ ...opts(f), checkpoints: [f.first, { ...f.second, previousCheckpointSha256: 'f'.repeat(64) }] });
  assert.equal(broken.valid, false); assert.equal(broken.code, 'checkpoint-signature-invalid');
  const truncated = verifyTrustedCheckpointHistory({ ...opts(f), checkpoints: [f.second] });
  assert.equal(truncated.code, 'checkpoint-chain-start-missing');
});

test('rejects invalid rotation signatures and untrusted checkpoint signers', t => {
  const f = setup(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  assert.equal(verifyTrustedCheckpointHistory({ ...opts(f), transitions: [{ ...f.transition, signature: 'bad' }] }).valid, false);
  const unknown = { ...f.second, signerKeyId: 'unknown' };
  assert.equal(verifyTrustedCheckpointHistory({ ...opts(f), checkpoints: [f.first, unknown] }).code, 'checkpoint-signer-untrusted');
});

test('fails closed when active or historical checkpoint signer is revoked', t => {
  const f = setup(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const event = createNotificationRecoveryAnchorKeyRevocation({ eventId: 'revoke-2', revokedSignerKeyId: 'anchor-2', reasonCode: 'KEY_COMPROMISED', issuedAt: now + 4, authorityPrivateKey: f.authority.privateKey });
  const result = verifyTrustedCheckpointHistory({ ...opts(f), revocations: [event] });
  assert.equal(result.valid, false); assert.equal(result.code, 'active-signer-revoked');
});


test('enforces externally pinned revision, head hash, and head freshness against rollback', t => {
  const f = setup(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const valid = opts(f);
  const headHash = NotificationRecoveryAuditAnchor.checkpointSha256(f.second);
  assert.equal(verifyTrustedCheckpointHistory({ ...valid, rollbackPolicy: { schemaVersion: 1, minimumRevision: f.second.registryRevision, expectedLastCheckpointSha256: headHash, maxHeadAgeMs: 20 } }).valid, true);
  assert.equal(verifyTrustedCheckpointHistory({ ...valid, rollbackPolicy: { schemaVersion: 1, minimumRevision: f.second.registryRevision + 1 } }).code, 'history-rollback-below-minimum-revision');
  assert.equal(verifyTrustedCheckpointHistory({ ...valid, rollbackPolicy: { schemaVersion: 1, expectedLastCheckpointSha256: 'f'.repeat(64) } }).code, 'history-head-hash-mismatch');
  assert.equal(verifyTrustedCheckpointHistory({ ...valid, rollbackPolicy: { schemaVersion: 1, maxHeadAgeMs: 1 } }).code, 'history-head-too-old');
});

test('rejects malformed external rollback policy and future head checkpoints', t => {
  const f = setup(); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  assert.equal(verifyTrustedCheckpointHistory({ ...opts(f), rollbackPolicy: { schemaVersion: 2, minimumRevision: 0 } }).code, 'rollback-policy-invalid');
  const future = { ...f.second, issuedAt: now + 100 };
  assert.equal(verifyTrustedCheckpointHistory({ ...opts(f), checkpoints: [f.first, future], rollbackPolicy: { schemaVersion: 1, maxHeadAgeMs: 1000 } }).code, 'checkpoint-issued-in-future');
});
