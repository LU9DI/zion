import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createNotificationRecoveryAnchorWitnessChallenge } from '../src/notification-recovery-anchor-witness-challenge.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startWitness(t, { dir, statePath, port }) {
  const keys = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'witness-private.pem');
  const tokenPath = join(dir, 'client-token');
  const token = `recovery-test-${'t'.repeat(48)}`;
  writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const child = spawn(process.execPath, ['scripts/serve-remote-witness.js'], {
    cwd: process.cwd(),
    env: { ...process.env, ZION_WITNESS_ID: 'recovery-witness', ZION_WITNESS_KEY_ID: 'recovery-key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: statePath, ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '127.0.0.1', ZION_WITNESS_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const endpoint = `http://127.0.0.1:${port}/v1/witness/challenge`;
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 404) { ready = true; break; }
    } catch {}
    await wait(25);
  }
  assert.equal(ready, true, `Witness failed to start: ${stderr}`);
  return { endpoint, token, child };
}

async function challengeRequest(endpoint, token) {
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'a'.repeat(64), ttlMs: 10_000 });
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(challenge) });
  return { response, body: await response.json() };
}

test('corrupt committed witness state fails closed and is preserved byte-for-byte', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const corrupt = '{"schemaVersion":2,"sequence":';
  writeFileSync(statePath, corrupt, { mode: 0o600 });
  const port = 22000 + Math.floor(Math.random() * 20000);
  const { endpoint, token } = await startWitness(t, { dir, statePath, port });
  const { response, body } = await challengeRequest(endpoint, token);
  assert.equal(response.status, 503);
  assert.equal(body.error, 'witness_state_unavailable');
  assert.equal(readFileSync(statePath, 'utf8'), corrupt, 'corrupt state must not be silently replaced');
});

test('abandoned witness state lock fails closed and remains available for operator investigation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-stale-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const lockPath = `${statePath}.lock`;
  mkdirSync(lockPath, { mode: 0o700 });
  const ownerEvidence = 'previous-owner-token\n';
  writeFileSync(join(lockPath, 'owner'), ownerEvidence, { mode: 0o600 });
  const port = 42000 + Math.floor(Math.random() * 15000);
  const { endpoint, token } = await startWitness(t, { dir, statePath, port });
  const { response, body } = await challengeRequest(endpoint, token);
  assert.equal(response.status, 503);
  assert.equal(body.error, 'witness_state_unavailable');
  assert.equal(lstatSync(lockPath).isDirectory(), true, 'service must not steal or delete an abandoned lock');
  assert.equal(readFileSync(join(lockPath, 'owner'), 'utf8'), ownerEvidence);
  assert.equal(existsSync(statePath), false, 'no state should be committed when lock acquisition fails');
});
