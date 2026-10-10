import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationRecoveryTrustRegistry } from '../src/notification-recovery-trust-registry.js';
import { NotificationRecoveryCasebook } from '../src/notification-recovery-casebook.js';
import { NotificationRecoverySignedDecisionStore } from '../src/notification-recovery-signed-decisions.js';

const keyId = 'operator-key-persisted';
const caseId = 'a1000000-0000-4000-8000-000000000001';
const decisionId = 'c1000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-10-09T12:00:00.000Z');
const report = () => ({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), mode: 'read-only-no-retry',
  counts: { before: 0, restored: 0, missingAfterRestore: 0, deliveryStateRegressions: 0, needsProviderReconciliation: 0, providerVerifiedDelivered: 0, providerVerifiedNotDelivered: 0, unresolved: 0 },
  missingAfterRestore: [], deliveryStateRegressions: [], needsProviderReconciliation: [], providerVerifiedDelivered: [], providerVerifiedNotDelivered: [], unresolved: [], automaticResendsPerformed: 0, recordsMutated: false });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'zion-trust-registry-'));
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const registryPath = join(root, 'trust', 'registry.json');
  const registry = new NotificationRecoveryTrustRegistry({ statePath: registryPath });
  registry.trustKey({ keyId, publicKey, actor: 'security-admin:test', reason: 'Initial approved recovery operator key.', now });
  const casebook = new NotificationRecoveryCasebook({ directory: join(root, 'cases') });
  const saved = casebook.save(report(), { caseId });
  const store = new NotificationRecoverySignedDecisionStore({ casebook, directory: join(root, 'decisions'), trustRegistry: registry });
  const request = { caseId, expectedReportSha256: saved.reportSha256, action: 'keep_pending', approver: 'operator:test', rationale: 'Keep notification pending until provider evidence is available.', keyId, privateKey, decisionId, now };
  return { root, registryPath, registry, publicKey, privateKey, casebook, store, request };
}

test('persists trusted keys and revocations across registry reconstruction', () => {
  const { registryPath, registry, publicKey } = setup();
  let reopened = new NotificationRecoveryTrustRegistry({ statePath: registryPath });
  assert.equal(reopened.getPublicKey(keyId), publicKey);
  reopened.revokeKey({ keyId, actor: 'security-admin:test', reason: 'Operator key rotation after incident.', now: now + 1000 });
  reopened = new NotificationRecoveryTrustRegistry({ statePath: registryPath });
  assert.equal(reopened.isRevoked(keyId), true);
  assert.equal(reopened.getPublicKey(keyId), null);
  assert.deepEqual(reopened.auditEvents().map(event => event.type), ['key-trusted', 'key-revoked']);
});

test('signed decision store consults durable registry dynamically for signing and verification', () => {
  const { registry, store, request, root, casebook } = setup();
  store.signDecision(request);
  registry.revokeKey({ keyId, actor: 'security-admin:test', reason: 'Compromised operator key revoked.', now: now + 1000 });
  assert.equal(store.read(decisionId, { now: now + 2000 }).status, 'revoked-key');
  assert.throws(() => store.signDecision({ ...request, decisionId: 'c1000000-0000-4000-8000-000000000002' }), error => error.code === 'NOTIFICATION_SIGNED_DECISION_KEY_REVOKED');
  const reopenedRegistry = new NotificationRecoveryTrustRegistry({ statePath: join(root, 'trust', 'registry.json') });
  const reopenedStore = new NotificationRecoverySignedDecisionStore({ casebook, directory: join(root, 'decisions'), trustRegistry: reopenedRegistry });
  assert.equal(reopenedStore.read(decisionId, { now: now + 2000 }).status, 'revoked-key');
});

test('rejects key ID rebinding, unsupported permissions, and revoked-key reactivation', () => {
  const { registry, publicKey } = setup();
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => registry.trustKey({ keyId, publicKey: otherKey, actor: 'security-admin:test', reason: 'Attempt key identity replacement.' }), error => error.code === 'NOTIFICATION_TRUST_REGISTRY_KEY_ID_CONFLICT');
  assert.throws(() => registry.trustKey({ keyId: 'unsupported', publicKey, permissions: ['execute_delivery'], actor: 'security-admin:test', reason: 'Attempt unsupported permission.' }), /Unsupported trust permission/);
  registry.revokeKey({ keyId, actor: 'security-admin:test', reason: 'Retire this key from recovery signing.' });
  assert.throws(() => registry.trustKey({ keyId, publicKey, actor: 'security-admin:test', reason: 'Attempt to reactivate revoked key.' }), error => error.code === 'NOTIFICATION_TRUST_REGISTRY_KEY_REVOKED');
});

test('detects registry tampering and rejects symbolic-link state files', () => {
  const { registryPath, root } = setup();
  const state = JSON.parse(readFileSync(registryPath, 'utf8'));
  state.keys[keyId].revoked = true;
  writeFileSync(registryPath, JSON.stringify(state));
  assert.throws(() => new NotificationRecoveryTrustRegistry({ statePath: registryPath }), error => error.code === 'NOTIFICATION_TRUST_REGISTRY_INTEGRITY_FAILURE');
  const linkPath = join(root, 'trust', 'registry-link.json');
  symlinkSync(registryPath, linkPath);
  assert.throws(() => new NotificationRecoveryTrustRegistry({ statePath: linkPath }), error => error.code === 'NOTIFICATION_TRUST_REGISTRY_UNSAFE_FILE');
});


test('serializes trust mutations across independent Node.js processes and preserves a verifiable event hash chain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zion-trust-concurrency-'));
  const registryPath = join(root, 'trust', 'registry.json');
  const childSource = `
    import { createHash, generateKeyPairSync } from 'node:crypto';
    import { NotificationRecoveryTrustRegistry } from ${JSON.stringify(new URL('../src/notification-recovery-trust-registry.js', import.meta.url).href)};
    const [statePath, keyId] = process.argv.slice(1);
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    const registry = new NotificationRecoveryTrustRegistry({ statePath });
    registry.trustKey({ keyId, publicKey, actor: 'concurrency-test', reason: 'Independent process registration test.', now: Date.now() });
  `;
  const ids = Array.from({ length: 8 }, (_, index) => `parallel-key-${index}`);
  await Promise.all(ids.map(keyId => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource, registryPath, keyId], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child ${keyId} exited ${code}: ${stderr}`)));
  })));
  const registry = new NotificationRecoveryTrustRegistry({ statePath: registryPath });
  assert.deepEqual(registry.list().map(entry => entry.keyId).sort(), ids.sort());
  const events = registry.auditEvents();
  assert.equal(events.length, ids.length);
  let previous = '0'.repeat(64);
  for (const event of events) {
    assert.equal(event.previousEventHash, previous);
    const { eventHash, ...body } = event;
    assert.equal(eventHash, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
    previous = eventHash;
  }
});

test('rejects a modified audit event even when the outer state digest is recomputed', () => {
  const { registryPath } = setup();
  const state = JSON.parse(readFileSync(registryPath, 'utf8'));
  state.events[0].reason = 'Changed after the event was signed';
  const canonicalState = JSON.stringify({ schemaVersion: state.schemaVersion, revision: state.revision, keys: state.keys, events: state.events });
  state.stateSha256 = createHash('sha256').update(canonicalState).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  assert.throws(() => new NotificationRecoveryTrustRegistry({ statePath: registryPath }), error => error.code === 'NOTIFICATION_TRUST_REGISTRY_AUDIT_CHAIN_FAILURE');
});
