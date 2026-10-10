import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createNotificationRecoveryAnchorWitnessChallenge } from '../src/notification-recovery-anchor-witness-challenge.js';

const startService = async ({ dir, privatePath, tokenPath, statePath, port, t, rateLimit = 60 }) => {
  const child = spawn(process.execPath, ['scripts/serve-remote-witness.js'], { cwd: process.cwd(), env: { ...process.env, ZION_WITNESS_ID: `witness-${port}`, ZION_WITNESS_KEY_ID: 'test-key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: statePath, ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '127.0.0.1', ZION_WITNESS_PORT: String(port), ZION_WITNESS_RATE_LIMIT_PER_MINUTE: String(rateLimit) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 404) return child; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`service failed to start: ${stderr}`);
};

test('two witness processes sharing state serialize sequence increments', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-multiprocess-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'witness.pem'); const tokenPath = join(dir, 'token'); const statePath = join(dir, 'state.json');
  const token = 'multiprocess-token-' + 'z'.repeat(48);
  writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const portA = 31000 + Math.floor(Math.random() * 8000); const portB = portA + 9000;
  await startService({ dir, privatePath, tokenPath, statePath, port: portA, t });
  await startService({ dir, privatePath, tokenPath, statePath, port: portB, t });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const challenges = [0, 1].map(() => createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'b'.repeat(64), ttlMs: 10_000 }));
  const results = await Promise.all(challenges.map((challenge, i) => fetch(`http://127.0.0.1:${i ? portB : portA}/v1/witness/challenge`, { method: 'POST', headers, body: JSON.stringify(challenge) })));
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  const bodies = await Promise.all(results.map(r => r.json()));
  assert.deepEqual(bodies.map(x => x.sequence).sort((a, b) => a - b), [1, 2]);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.sequence, 2);
  assert.equal(state.consumedNonces.length, 2);
});


test('authenticated requests are rate limited with HTTP 429', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-ratelimit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'witness.pem'); const tokenPath = join(dir, 'token'); const statePath = join(dir, 'state.json');
  const token = 'rate-limit-token-' + 'q'.repeat(48);
  writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const port = 22000 + Math.floor(Math.random() * 8000);
  await startService({ dir, privatePath, tokenPath, statePath, port, t, rateLimit: 1 });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const endpoint = `http://127.0.0.1:${port}/v1/witness/challenge`;
  const firstChallenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'c'.repeat(64), ttlMs: 10_000 });
  const secondChallenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'd'.repeat(64), ttlMs: 10_000 });
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(firstChallenge) })).status, 200);
  const limited = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(secondChallenge) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).sequence, 1);
});

test('shared rate limit is enforced across two witness processes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-shared-rate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'witness.pem'); const tokenPath = join(dir, 'token'); const statePath = join(dir, 'state.json');
  const token = 'shared-rate-token-' + 'r'.repeat(48);
  writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const portA = 32000 + Math.floor(Math.random() * 7000); const portB = portA + 8000;
  await startService({ dir, privatePath, tokenPath, statePath, port: portA, t, rateLimit: 1 });
  await startService({ dir, privatePath, tokenPath, statePath, port: portB, t, rateLimit: 1 });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const challengeA = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'e'.repeat(64), ttlMs: 10_000 });
  const challengeB = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: 'f'.repeat(64), ttlMs: 10_000 });
  const first = await fetch(`http://127.0.0.1:${portA}/v1/witness/challenge`, { method: 'POST', headers, body: JSON.stringify(challengeA) });
  assert.equal(first.status, 200);
  const second = await fetch(`http://127.0.0.1:${portB}/v1/witness/challenge`, { method: 'POST', headers, body: JSON.stringify(challengeB) });
  assert.equal(second.status, 429);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).sequence, 1);
  const rateState = JSON.parse(readFileSync(`${statePath}.rate-limits.json`, 'utf8'));
  assert.equal(rateState.schemaVersion, 1);
  assert.equal(rateState.windows.length, 1);
  assert.equal(rateState.windows[0].count, 1);
});


test('audit output is structured and never includes bearer credentials', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const privatePath = join(dir, 'witness.pem'); const tokenPath = join(dir, 'token'); const statePath = join(dir, 'state.json');
  const token = 'audit-secret-token-' + 's'.repeat(48);
  writeFileSync(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  const port = 33000 + Math.floor(Math.random() * 6000);
  const child = spawn(process.execPath, ['scripts/serve-remote-witness.js'], { cwd: process.cwd(), env: { ...process.env, ZION_WITNESS_ID: 'audit-witness', ZION_WITNESS_KEY_ID: 'audit-key', ZION_WITNESS_PRIVATE_KEY: privatePath, ZION_WITNESS_STATE: statePath, ZION_WITNESS_CLIENT_TOKEN_FILE: tokenPath, ZION_WITNESS_HOST: '127.0.0.1', ZION_WITNESS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 404) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, `service did not start: ${stderr}`);
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256: '9'.repeat(64), ttlMs: 10_000 });
  const response = await fetch(`http://127.0.0.1:${port}/v1/witness/challenge`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(challenge) });
  assert.equal(response.status, 200);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(stdout.includes(token), false, 'audit output must not contain the bearer token');
  const records = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(records.some(record => record.event === 'authentication_succeeded' && record.clientId === 'legacy'), true);
  assert.equal(records.every(record => !('token' in record) && !('authorization' in record)), true);
});
