import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { requestRemoteWitness } from '../scripts/request-remote-witness.js';
import { inspectPersistentAnchorState } from '../src/notification-recovery-anchor-diagnostics.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('end-to-end: remote witness signs a live challenge and diagnostics verify saved evidence', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const anchorDir = join(dir, 'anchor'); mkdirSync(anchorDir);
  const anchorPath = join(anchorDir, 'checkpoint.json');
  const historyPath = join(dir, 'history.json');
  const signer = generateKeyPairSync('ed25519');
  const witness = generateKeyPairSync('ed25519');
  const registryPath = join(dir, 'registry.json');
  const state = { schemaVersion: 1, revision: 1, keys: {}, events: [] };
  state.stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  const checkpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath, signerKeyId: 'e2e-signer', privateKey: signer.privateKey });
  writeFileSync(anchorPath, JSON.stringify(checkpoint), { mode: 0o600 });
  writeFileSync(historyPath, JSON.stringify([checkpoint]), { mode: 0o600 });
  const signerPublicPath = join(dir, 'signer-public.pem');
  writeFileSync(signerPublicPath, signer.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const witnessPrivatePath = join(dir, 'witness-private.pem');
  const witnessPublicPath = join(dir, 'witness-public.pem');
  const tokenPath = join(dir, 'token');
  const statePath = join(dir, 'witness-state.json');
  const outputPath = join(dir, 'evidence.json');
  const token = `e2e-token-${'x'.repeat(48)}`;
  writeFileSync(witnessPrivatePath, witness.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(witnessPublicPath, witness.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const port = 35000 + Math.floor(Math.random() * 12000);
  const child = spawn(process.execPath, ['scripts/serve-remote-witness.js'], { cwd: process.cwd(), env: { ...process.env, ZION_WITNESS_ID: 'e2e-witness', ZION_WITNESS_KEY_ID: 'e2e-key', ZION_WITNESS_PRIVATE_KEY: witnessPrivatePath, ZION_WITNESS_STATE: statePath, ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '127.0.0.1', ZION_WITNESS_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.status === 404) { ready = true; break; } } catch {}
    await wait(25);
  }
  assert.equal(ready, true, `witness service did not start: ${stderr}`);
  const result = await requestRemoteWitness({ endpoint: `http://127.0.0.1:${port}/v1/witness/challenge`, historyPath, tokenFile: tokenPath, publicKeyPath: witnessPublicPath, expectedWitnessId: 'e2e-witness', expectedWitnessKeyId: 'e2e-key', outputPath });
  assert.equal(result.valid, true);
  assert.equal(result.sequence, 1);
  const evidence = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(evidence.historyHeadSha256, NotificationRecoveryAuditAnchor.checkpointSha256(checkpoint));
  const report = inspectPersistentAnchorState({ anchorPath, historyPath, publicKeyPath: signerPublicPath, expectedSignerKeyId: 'e2e-signer', freshnessChallengeResponsePath: outputPath, freshnessPublicKeyPath: witnessPublicPath, freshnessChallengeNonce: evidence.nonce, expectedWitnessKeyId: 'e2e-key', requireFreshnessWitness: true });
  assert.equal(report.checkpointChain.state, 'verified');
  assert.equal(report.freshness.state, 'verified', JSON.stringify(report.freshness));
});
