import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createNotificationRecoveryAnchorWitnessChallenge, verifyNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

const hash = 'a'.repeat(64);
test('remote witness service signs challenge, increments durable sequence and rejects replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'witness.pem'); const statePath = join(dir, 'sequence.json'); const tokenPath = join(dir, 'client-token');
  const clientToken = 'test-client-token-' + 'x'.repeat(48);
  writeFileSync(tokenPath, clientToken + '\n', { mode: 0o600 });
  writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(process.execPath, ['scripts/serve-remote-witness.js'], { cwd: process.cwd(), env: { ...process.env, ZION_WITNESS_ID: 'test-witness', ZION_WITNESS_KEY_ID: 'test-key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: statePath, ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '127.0.0.1', ZION_WITNESS_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => child.kill('SIGTERM'));
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 404) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, `service did not start: ${stderr}`);
  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${clientToken}` };
  const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/witness/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: hash, ttlMs: 10_000 });
  const endpoint = `http://127.0.0.1:${port}/v1/witness/challenge`;
  const first = await fetch(endpoint, { method: 'POST', headers: authHeaders, body: JSON.stringify(challenge) });
  assert.equal(first.status, 200);
  const response = await first.json();
  assert.equal(response.sequence, 1);
  assert.equal(verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey: keys.publicKey, expectedNonce: challenge.nonce, expectedHistoryHeadSha256: hash, expectedWitnessId: 'test-witness', expectedWitnessKeyId: 'test-key', now: Date.now(), maxResponseAgeMs: 10_000 }).valid, true);
  const replay = await fetch(endpoint, { method: 'POST', headers: authHeaders, body: JSON.stringify(challenge) });
  assert.equal(replay.status, 409);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).sequence, 1);
  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.consumedNonces.some(item => item.nonce === challenge.nonce), true);
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  const restarted = spawn(process.execPath, ['scripts/serve-remote-witness.js'], { cwd: process.cwd(), env: { ...process.env, ZION_WITNESS_ID: 'test-witness', ZION_WITNESS_KEY_ID: 'test-key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: statePath, ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '127.0.0.1', ZION_WITNESS_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => restarted.kill('SIGTERM'));
  let restartedReady = false;
  for (let i = 0; i < 80; i += 1) {
    if (restarted.exitCode !== null) break;
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 404) { restartedReady = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(restartedReady, true);
  const replayAfterRestart = await fetch(endpoint, { method: 'POST', headers: authHeaders, body: JSON.stringify(challenge) });
  assert.equal(replayAfterRestart.status, 409);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).sequence, 1);

  // Rotate without restarting: both credentials overlap briefly, then revoke the old one.
  const nextToken = 'rotated-client-token-' + 'y'.repeat(48);
  writeFileSync(tokenPath, JSON.stringify({ schemaVersion: 1, clients: [
    { id: 'client-a', token: clientToken, enabled: true },
    { id: 'client-b', token: nextToken, enabled: true },
  ] }) + '\n', { mode: 0o600 });
  const nextChallenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: hash, ttlMs: 10_000 });
  const nextResponse = await fetch(endpoint, { method: 'POST', headers: { ...authHeaders, authorization: `Bearer ${nextToken}` }, body: JSON.stringify(nextChallenge) });
  assert.equal(nextResponse.status, 200);
  assert.equal((await nextResponse.json()).sequence, 2);
  writeFileSync(tokenPath, JSON.stringify({ schemaVersion: 1, clients: [
    { id: 'client-a', token: clientToken, enabled: false },
    { id: 'client-b', token: nextToken, enabled: true },
  ] }) + '\n', { mode: 0o600 });
  const revoked = await fetch(endpoint, { method: 'POST', headers: authHeaders, body: JSON.stringify(createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: hash, ttlMs: 10_000 })) });
  assert.equal(revoked.status, 401);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).sequence, 2);
});
