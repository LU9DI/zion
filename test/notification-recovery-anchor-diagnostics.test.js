import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { createNotificationRecoveryAnchorTrustPolicy } from '../src/notification-recovery-anchor-trust-policy.js';
import { createNotificationRecoveryAnchorKeyTransition } from '../src/notification-recovery-anchor-key-rotation.js';
import { createNotificationRecoveryAnchorKeyRevocation } from '../src/notification-recovery-anchor-key-revocation.js';
import { inspectPersistentAnchorState } from '../src/notification-recovery-anchor-diagnostics.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zion-anchor-diagnostics-'));
  const dir = join(root, 'anchor');
  mkdirSync(dir);
  const anchorPath = join(dir, 'checkpoint.json');
  const keys = generateKeyPairSync('ed25519');
  const registryPath = join(root, 'registry.json');
  const state = { schemaVersion: 1, revision: 1, keys: {}, events: [] };
  state.stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  const checkpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath, signerKeyId: 'diagnostic-test', privateKey: keys.privateKey, issuedAt: Date.parse('2026-10-09T12:00:00Z') });
  return { root, dir, anchorPath, checkpoint, keys, registryPath };
}

test('read-only diagnostics reports absent checkpoint and does not change directory contents', () => {
  const ctx = fixture();
  const before = readdirSync(ctx.dir).sort();
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath });
  assert.equal(report.mode, 'read_only');
  assert.equal(report.checkpoint.state, 'absent');
  assert.equal(report.lock.state, 'absent');
  assert.deepEqual(readdirSync(ctx.dir).sort(), before);
});

test('diagnostics reports visible checkpoint, lock ambiguity and orphaned temp files without cleanup', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const lockPath = `${ctx.anchorPath}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: 987654321, acquiredAt: 1, token: 'opaque-token' }), { mode: 0o600 });
  const tempPath = `${ctx.anchorPath}.tmp-abandoned`;
  writeFileSync(tempPath, '{partial');
  const before = readdirSync(ctx.dir).sort();
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath });
  assert.equal(report.checkpoint.state, 'visible_checkpoint');
  assert.equal(report.checkpoint.durability, 'historical_durability_unknown');
  assert.equal(report.lock.state, 'present');
  assert.equal(report.lock.ownership, 'unknown');
  assert.equal(report.temporaryArtifacts.length, 1);
  assert.equal(report.temporaryArtifacts[0].name, 'checkpoint.json.tmp-abandoned');
  assert.deepEqual(readdirSync(ctx.dir).sort(), before, 'diagnostic must not mutate artifacts');
});

test('diagnostics flags malformed checkpoint and refuses symlink lock without following it', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, '{broken');
  const target = join(ctx.root, 'target-lock');
  writeFileSync(target, JSON.stringify({ pid: process.pid }));
  symlinkSync(target, `${ctx.anchorPath}.lock`);
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath });
  assert.equal(report.overall, 'attention_required');
  assert.equal(report.checkpoint.state, 'untrusted');
  assert.equal(report.lock.state, 'unsafe');
  assert.equal(report.lock.issue.code, 'SYMLINK_REFUSED');
});


test('diagnostics integrates signed-chain verification without mutating evidence', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const before = [readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()];
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test' });
  assert.equal(report.checkpointChain.state, 'verified');
  assert.equal(report.checkpointChain.verifiedCount, 1);
  assert.equal(report.overall, 'no_obvious_local_recovery_artifacts');
  assert.deepEqual([readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()], before, 'chain diagnostics must be read-only');
});

test('diagnostics flags a history whose latest checkpoint differs from visible anchor', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  const other = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: ctx.registryPath, signerKeyId: 'diagnostic-test', privateKey: ctx.keys.privateKey, issuedAt: ctx.checkpoint.issuedAt + 1 });
  writeFileSync(historyPath, JSON.stringify([other]), { mode: 0o600 });
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test', now: ctx.checkpoint.issuedAt + 1 });
  assert.equal(report.checkpointChain.state, 'untrusted');
  assert.equal(report.checkpointChain.code, 'latest-checkpoint-mismatch');
  assert.equal(report.overall, 'attention_required');
});

test('diagnostics reports incomplete chain-verification inputs explicitly', () => {
  const ctx = fixture();
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath: join(ctx.root, 'history.json') });
  assert.equal(report.checkpointChain.state, 'not_checked');
  assert.equal(report.checkpointChain.issue.code, 'CHAIN_INPUTS_INCOMPLETE');
});


test('diagnostics verifies history against an explicit trust policy and remains read-only', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const policyPath = join(ctx.root, 'trust-policy.json');
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(policyPath, JSON.stringify(createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'diagnostic-test', publicKey: ctx.keys.publicKey })), { mode: 0o600 });
  const before = [readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()];
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, trustPolicyPath: policyPath });
  assert.equal(report.checkpointChain.state, 'verified');
  assert.equal(report.checkpointChain.trustPolicySignerKeyId, 'diagnostic-test');
  assert.match(report.checkpointChain.trustPolicyPublicKeySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual([readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()], before);
});

test('diagnostics rejects a trust policy with a mismatched public-key fingerprint', () => {
  const ctx = fixture();
  const historyPath = join(ctx.root, 'history.json');
  const policyPath = join(ctx.root, 'trust-policy.json');
  const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'diagnostic-test', publicKey: ctx.keys.publicKey });
  policy.publicKeySha256 = '0'.repeat(64);
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, trustPolicyPath: policyPath });
  assert.equal(report.checkpointChain.state, 'untrusted');
  assert.equal(report.checkpointChain.issue.code, 'INVALID_TRUST_POLICY');
  assert.equal(report.checkpointChain.issue.detail, 'trust-policy-fingerprint-mismatch');
});


test('diagnostics resolves active signer through signed rotation history before verifying checkpoints', () => {
  const ctx = fixture();
  const nextKeys = generateKeyPairSync('ed25519');
  const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'diagnostic-test', publicKey: ctx.keys.publicKey });
  const transition = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'diagnostic-test', signerKeyId: 'diagnostic-test-rotated', publicKey: nextKeys.publicKey, previousPrivateKey: ctx.keys.privateKey, issuedAt: ctx.checkpoint.issuedAt + 10 });
  const rotatedCheckpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: ctx.registryPath, signerKeyId: 'diagnostic-test-rotated', privateKey: nextKeys.privateKey, issuedAt: ctx.checkpoint.issuedAt + 20 });
  writeFileSync(ctx.anchorPath, `${JSON.stringify(rotatedCheckpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const policyPath = join(ctx.root, 'trust-policy.json');
  const rotationPath = join(ctx.root, 'rotations.json');
  writeFileSync(historyPath, JSON.stringify([rotatedCheckpoint]), { mode: 0o600 });
  writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  writeFileSync(rotationPath, JSON.stringify([transition]), { mode: 0o600 });
  const before = [readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()];
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, trustPolicyPath: policyPath, rotationHistoryPath: rotationPath, now: rotatedCheckpoint.issuedAt + 1 });
  assert.equal(report.checkpointChain.state, 'verified');
  assert.equal(report.checkpointChain.rotation.valid, true);
  assert.equal(report.checkpointChain.rotation.verifiedCount, 1);
  assert.equal(report.checkpointChain.rotation.activeSignerKeyId, 'diagnostic-test-rotated');
  assert.deepEqual([readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()], before, 'rotation diagnostics must be read-only');
});

test('diagnostics refuses checkpoint verification when signed rotation history is tampered', () => {
  const ctx = fixture();
  const nextKeys = generateKeyPairSync('ed25519');
  const policy = createNotificationRecoveryAnchorTrustPolicy({ signerKeyId: 'diagnostic-test', publicKey: ctx.keys.publicKey });
  const transition = createNotificationRecoveryAnchorKeyTransition({ previousSignerKeyId: 'diagnostic-test', signerKeyId: 'diagnostic-test-rotated', publicKey: nextKeys.publicKey, previousPrivateKey: ctx.keys.privateKey, issuedAt: ctx.checkpoint.issuedAt + 10 });
  const tamperedTransition = { ...transition, signerKeyId: 'forged-key-id' };
  const rotatedCheckpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath: ctx.registryPath, signerKeyId: 'diagnostic-test-rotated', privateKey: nextKeys.privateKey, issuedAt: ctx.checkpoint.issuedAt + 20 });
  const historyPath = join(ctx.root, 'history.json');
  const policyPath = join(ctx.root, 'trust-policy.json');
  const rotationPath = join(ctx.root, 'rotations.json');
  writeFileSync(historyPath, JSON.stringify([rotatedCheckpoint]));
  writeFileSync(policyPath, JSON.stringify(policy));
  writeFileSync(rotationPath, JSON.stringify([tamperedTransition]));
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, trustPolicyPath: policyPath, rotationHistoryPath: rotationPath, now: rotatedCheckpoint.issuedAt + 1 });
  assert.equal(report.checkpointChain.state, 'untrusted');
  assert.equal(report.checkpointChain.issue.code, 'KEY_ROTATION_UNTRUSTED');
  assert.equal(report.overall, 'attention_required');
});


test('diagnostics refuses a checkpoint history signed by a revoked key and remains read-only', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  const authority = generateKeyPairSync('ed25519');
  const authorityPath = join(ctx.root, 'revocation-authority.pem');
  const revocationPath = join(ctx.root, 'revocations.json');
  const event = createNotificationRecoveryAnchorKeyRevocation({ eventId: 'revoke-diagnostic-key', revokedSignerKeyId: 'diagnostic-test', reasonCode: 'KEY_COMPROMISED', issuedAt: ctx.checkpoint.issuedAt + 1, authorityPrivateKey: authority.privateKey });
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  writeFileSync(authorityPath, authority.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  writeFileSync(revocationPath, JSON.stringify([event]), { mode: 0o600 });
  const before = [readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()];
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test', revocationHistoryPath: revocationPath, revocationAuthorityPublicKeyPath: authorityPath, now: ctx.checkpoint.issuedAt + 2 });
  assert.equal(report.checkpointChain.state, 'untrusted');
  assert.equal(report.checkpointChain.issue.code, 'ACTIVE_SIGNER_REVOKED');
  assert.equal(report.overall, 'attention_required');
  assert.deepEqual([readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()], before, 'revocation diagnostics must be read-only');
});

test('diagnostics refuses revocation history without independently supplied authority key', () => {
  const ctx = fixture();
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath: join(ctx.root, 'history.json'), publicKeyPath: join(ctx.root, 'key.pem'), revocationHistoryPath: join(ctx.root, 'revocations.json') });
  assert.equal(report.checkpointChain.state, 'not_checked');
  assert.equal(report.checkpointChain.issue.code, 'CHAIN_INPUTS_INCOMPLETE');
});

import { createNotificationRecoveryAnchorFreshnessWitness } from '../src/notification-recovery-anchor-freshness-witness.js';

test('diagnostics verifies an independent freshness witness bound to the exact history head and remains read-only', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  const witnessPath = join(ctx.root, 'freshness-witness.json');
  const witnessPublicKeyPath = join(ctx.root, 'freshness-public.pem');
  const witnessKeys = generateKeyPairSync('ed25519');
  const head = NotificationRecoveryAuditAnchor.checkpointSha256(ctx.checkpoint);
  const now = ctx.checkpoint.issuedAt + 1_000;
  const witness = createNotificationRecoveryAnchorFreshnessWitness({ witnessId: 'independent-witness', sequence: 12, issuedAt: now, historyHeadSha256: head, witnessKeyId: 'freshness-key-1', privateKey: witnessKeys.privateKey });
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  writeFileSync(witnessPath, JSON.stringify(witness), { mode: 0o600 });
  writeFileSync(witnessPublicKeyPath, witnessKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const before = [readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()];
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test', freshnessWitnessPath: witnessPath, freshnessPublicKeyPath: witnessPublicKeyPath, expectedWitnessKeyId: 'freshness-key-1', minimumWitnessSequence: 10, requireFreshnessWitness: true, now, maxAgeMs: 5_000 });
  assert.equal(report.checkpointChain.state, 'verified');
  assert.equal(report.freshness.state, 'verified');
  assert.equal(report.freshness.sequence, 12);
  assert.equal(report.overall, 'no_obvious_local_recovery_artifacts');
  assert.deepEqual([readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()], before, 'freshness diagnostics must be read-only');
});

test('diagnostics rejects a stale freshness witness and requires attention', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  const witnessPath = join(ctx.root, 'freshness-witness.json');
  const witnessPublicKeyPath = join(ctx.root, 'freshness-public.pem');
  const witnessKeys = generateKeyPairSync('ed25519');
  const now = ctx.checkpoint.issuedAt + 10_000;
  const witness = createNotificationRecoveryAnchorFreshnessWitness({ witnessId: 'independent-witness', sequence: 12, issuedAt: ctx.checkpoint.issuedAt, historyHeadSha256: NotificationRecoveryAuditAnchor.checkpointSha256(ctx.checkpoint), witnessKeyId: 'freshness-key-1', privateKey: witnessKeys.privateKey });
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]));
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(witnessPath, JSON.stringify(witness));
  writeFileSync(witnessPublicKeyPath, witnessKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test', freshnessWitnessPath: witnessPath, freshnessPublicKeyPath: witnessPublicKeyPath, now, maxAgeMs: 20_000, freshnessMaxAgeMs: 1_000 });
  assert.equal(report.freshness.state, 'untrusted');
  assert.equal(report.freshness.code, 'witness-stale');
  assert.equal(report.checkpointChain.state, 'untrusted');
  assert.equal(report.overall, 'attention_required');
});

test('diagnostics marks required freshness as not checked when witness inputs are absent', () => {
  const ctx = fixture();
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath: join(ctx.root, 'history.json'), publicKeyPath: join(ctx.root, 'key.pem'), requireFreshnessWitness: true });
  assert.equal(report.checkpointChain.state, 'not_checked');
  assert.equal(report.checkpointChain.issue.code, 'CHAIN_INPUTS_INCOMPLETE');
  assert.equal(report.overall, 'attention_required');
});

test('diagnostics accepts a threshold of independent freshness witnesses and remains read-only', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const now = ctx.checkpoint.issuedAt + 1_000;
  const head = NotificationRecoveryAuditAnchor.checkpointSha256(ctx.checkpoint);
  const members = [];
  for (const id of ['quorum-a', 'quorum-b', 'quorum-c']) {
    const keys = generateKeyPairSync('ed25519');
    const witnessPath = `${id}.json`;
    const keyPath = `${id}.pem`;
    const witness = createNotificationRecoveryAnchorFreshnessWitness({ witnessId: id, sequence: 20, issuedAt: now, historyHeadSha256: head, witnessKeyId: `${id}-key`, privateKey: keys.privateKey });
    writeFileSync(join(ctx.root, witnessPath), JSON.stringify(witness), { mode: 0o600 });
    writeFileSync(join(ctx.root, keyPath), keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    members.push({ witnessPath, publicKeyPath: keyPath, expectedWitnessKeyId: `${id}-key`, minimumSequence: 18 });
  }
  const manifestPath = join(ctx.root, 'quorum.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, threshold: 2, witnesses: members }), { mode: 0o600 });
  const before = readdirSync(ctx.root).sort();
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test', freshnessQuorumManifestPath: manifestPath, requireFreshnessWitness: true, now, maxAgeMs: 5_000 });
  assert.equal(report.freshness.state, 'verified');
  assert.equal(report.freshness.threshold, 2);
  assert.equal(report.freshness.verifiedCount, 3);
  assert.equal(report.checkpointChain.state, 'verified');
  assert.deepEqual(readdirSync(ctx.root).sort(), before, 'quorum diagnostics must be read-only');
});

test('diagnostics rejects a quorum manifest with duplicate witness identities', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`);
  const historyPath = join(ctx.root, 'history.json');
  const publicKeyPath = join(ctx.root, 'anchor-public.pem');
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]));
  writeFileSync(publicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const now = ctx.checkpoint.issuedAt + 1_000;
  const head = NotificationRecoveryAuditAnchor.checkpointSha256(ctx.checkpoint);
  const keys = generateKeyPairSync('ed25519');
  const witness = createNotificationRecoveryAnchorFreshnessWitness({ witnessId: 'duplicate', sequence: 2, issuedAt: now, historyHeadSha256: head, witnessKeyId: 'same-key', privateKey: keys.privateKey });
  writeFileSync(join(ctx.root, 'witness.json'), JSON.stringify(witness));
  writeFileSync(join(ctx.root, 'witness.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const manifestPath = join(ctx.root, 'quorum.json');
  const member = { witnessPath: 'witness.json', publicKeyPath: 'witness.pem', expectedWitnessKeyId: 'same-key' };
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, threshold: 2, witnesses: [member, member] }));
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath, expectedSignerKeyId: 'diagnostic-test', freshnessQuorumManifestPath: manifestPath, requireFreshnessWitness: true, now, maxAgeMs: 5_000 });
  assert.equal(report.freshness.state, 'untrusted');
  assert.equal(report.freshness.code, 'quorum-membership-duplicate-or-malformed');
  assert.equal(report.overall, 'attention_required');
});

import { createNotificationRecoveryAnchorWitnessChallenge, createNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

test('diagnostics verifies a nonce-bound remote witness response and remains read-only', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const anchorPublicKeyPath = join(ctx.root, 'anchor-public.pem');
  const responsePath = join(ctx.root, 'challenge-response.json');
  const witnessPublicKeyPath = join(ctx.root, 'remote-witness.pem');
  const witnessKeys = generateKeyPairSync('ed25519');
  const now = ctx.checkpoint.issuedAt + 1_000;
  const head = NotificationRecoveryAuditAnchor.checkpointSha256(ctx.checkpoint);
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: head, now, ttlMs: 5_000 });
  const response = createNotificationRecoveryAnchorWitnessChallengeResponse({ challenge, witnessId: 'remote-witness', witnessKeyId: 'remote-key', sequence: 31, issuedAt: now, privateKey: witnessKeys.privateKey });
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]), { mode: 0o600 });
  writeFileSync(anchorPublicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  writeFileSync(responsePath, JSON.stringify(response), { mode: 0o600 });
  writeFileSync(witnessPublicKeyPath, witnessKeys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const before = [readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()];
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath: anchorPublicKeyPath, expectedSignerKeyId: 'diagnostic-test', freshnessChallengeResponsePath: responsePath, freshnessPublicKeyPath: witnessPublicKeyPath, freshnessChallengeNonce: challenge.nonce, expectedWitnessKeyId: 'remote-key', minimumWitnessSequence: 30, freshnessMaxAgeMs: 5_000, requireFreshnessWitness: true, now, maxAgeMs: 5_000 });
  assert.equal(report.checkpointChain.state, 'verified');
  assert.equal(report.freshness.state, 'verified');
  assert.equal(report.freshness.sequence, 31);
  assert.equal(report.freshness.replayProtection, 'caller_must_generate_a_new_random_nonce_for_each_check');
  assert.deepEqual([readdirSync(ctx.dir).sort(), readdirSync(ctx.root).sort()], before, 'challenge-response diagnostics must be read-only');
});

test('diagnostics rejects a replayed remote witness response with the wrong nonce', () => {
  const ctx = fixture();
  writeFileSync(ctx.anchorPath, `${JSON.stringify(ctx.checkpoint)}\n`, { mode: 0o600 });
  const historyPath = join(ctx.root, 'history.json');
  const anchorPublicKeyPath = join(ctx.root, 'anchor-public.pem');
  const responsePath = join(ctx.root, 'challenge-response.json');
  const witnessPublicKeyPath = join(ctx.root, 'remote-witness.pem');
  const witnessKeys = generateKeyPairSync('ed25519');
  const now = ctx.checkpoint.issuedAt + 1_000;
  const head = NotificationRecoveryAuditAnchor.checkpointSha256(ctx.checkpoint);
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: head, now, ttlMs: 5_000 });
  const response = createNotificationRecoveryAnchorWitnessChallengeResponse({ challenge, witnessId: 'remote-witness', witnessKeyId: 'remote-key', sequence: 31, issuedAt: now, privateKey: witnessKeys.privateKey });
  writeFileSync(historyPath, JSON.stringify([ctx.checkpoint]));
  writeFileSync(anchorPublicKeyPath, ctx.keys.publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(responsePath, JSON.stringify(response));
  writeFileSync(witnessPublicKeyPath, witnessKeys.publicKey.export({ type: 'spki', format: 'pem' }));
  const report = inspectPersistentAnchorState({ anchorPath: ctx.anchorPath, historyPath, publicKeyPath: anchorPublicKeyPath, expectedSignerKeyId: 'diagnostic-test', freshnessChallengeResponsePath: responsePath, freshnessPublicKeyPath: witnessPublicKeyPath, freshnessChallengeNonce: 'a'.repeat(64), expectedWitnessKeyId: 'remote-key', requireFreshnessWitness: true, now, maxAgeMs: 5_000 });
  assert.equal(report.freshness.state, 'untrusted');
  assert.equal(report.freshness.code, 'challenge-nonce-mismatch');
  assert.equal(report.overall, 'attention_required');
});
