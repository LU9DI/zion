import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { requestRemoteWitness } from '../scripts/request-remote-witness.js';
import { createNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-client-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signer = generateKeyPairSync('ed25519');
  const registryPath = join(dir, 'registry.json');
  const state = { schemaVersion: 1, revision: 1, keys: {}, events: [] };
  state.stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  const checkpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath, signerKeyId: 'client-test', privateKey: signer.privateKey });
  const historyPath = join(dir, 'history.json');
  writeFileSync(historyPath, JSON.stringify([checkpoint]));
  const witness = generateKeyPairSync('ed25519');
  const publicKeyPath = join(dir, 'witness-public.pem');
  writeFileSync(publicKeyPath, witness.publicKey.export({ type: 'spki', format: 'pem' }));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 't'.repeat(48));
  const outputPath = join(dir, 'evidence.json');
  const base = { endpoint: 'https://witness.example/v1/witness/challenge', historyPath, tokenFile, publicKeyPath, expectedWitnessId: 'witness-a', expectedWitnessKeyId: 'key-a', outputPath };
  return { base, outputPath, witnessPrivateKey: witness.privateKey };
}

for (const scenario of [
  { name: 'network interruption', fetchImpl: async () => { throw new TypeError('socket disconnected'); }, error: /socket disconnected/ },
  { name: 'non-success HTTP response', fetchImpl: async () => ({ ok: false, status: 503 }), error: /HTTP 503/ },
  { name: 'non-JSON response', fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), text: async () => '<html>partial gateway error</html>' }), error: /not JSON/ },
  { name: 'truncated JSON response', fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => '{"schemaVersion":1,"signature":' }), error: /invalid JSON/ },
  { name: 'oversized response body', fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => ' '.repeat(16 * 1024 + 1) }), error: /exceeds 16 KiB/ },
]) {
  test(`remote witness client: ${scenario.name} never commits evidence`, async t => {
    const { base, outputPath } = fixture(t);
    await assert.rejects(requestRemoteWitness({ ...base, fetchImpl: scenario.fetchImpl }), scenario.error);
    assert.equal(existsSync(outputPath), false, 'failed or incomplete response must not create an evidence file');
  });
}


test('remote witness client: interrupted response body never commits evidence', async t => {
  const { base, outputPath } = fixture(t);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => { throw new TypeError('connection reset while reading body'); },
  });
  await assert.rejects(requestRemoteWitness({ ...base, fetchImpl }), /connection reset while reading body/);
  assert.equal(existsSync(outputPath), false);
});

function signedFetch(witnessPrivateKey) {
  return async (_url, options) => {
    const challenge = JSON.parse(options.body);
    const signedResponse = createNotificationRecoveryAnchorWitnessChallengeResponse({
      challenge,
      witnessId: 'witness-a',
      witnessKeyId: 'key-a',
      sequence: 1,
      issuedAt: challenge.issuedAt,
      privateKey: witnessPrivateKey,
    });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      text: async () => JSON.stringify(signedResponse),
    };
  };
}

test('remote witness client: existing evidence is never overwritten', async t => {
  const { base, outputPath, witnessPrivateKey } = fixture(t);
  const sentinel = '{"preexisting":"keep-me"}\n';
  writeFileSync(outputPath, sentinel, { mode: 0o600 });
  await assert.rejects(requestRemoteWitness({ ...base, fetchImpl: signedFetch(witnessPrivateKey) }), /EEXIST/);
  assert.equal(readFileSync(outputPath, 'utf8'), sentinel);
});

test('remote witness client: concurrent successful responses have a single evidence-file winner', async t => {
  const { base, outputPath, witnessPrivateKey } = fixture(t);
  const fetchImpl = signedFetch(witnessPrivateKey);
  const results = await Promise.allSettled([
    requestRemoteWitness({ ...base, fetchImpl }),
    requestRemoteWitness({ ...base, fetchImpl }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(saved.witnessId, 'witness-a');
  assert.equal(saved.witnessKeyId, 'key-a');
});


test('remote witness client: successful evidence publication is complete, private, and leaves no temporary file', async t => {
  const { base, outputPath, witnessPrivateKey } = fixture(t);
  const result = await requestRemoteWitness({ ...base, fetchImpl: signedFetch(witnessPrivateKey) });
  assert.equal(result.valid, true);
  const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(saved.witnessId, 'witness-a');
  if (process.platform !== 'win32') assert.equal((statSync(outputPath).mode & 0o777), 0o600);
  const leftovers = readdirSync(dirname(outputPath)).filter(name => name.startsWith('evidence.json.') && name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'temporary publication names should be removed after successful commit');
});

test('remote witness client: orphaned temporary file never replaces destination evidence', async t => {
  const { base, outputPath, witnessPrivateKey } = fixture(t);
  const sentinel = '{"preexisting":"immutable"}\n';
  writeFileSync(outputPath, sentinel, { mode: 0o600 });
  writeFileSync(`${outputPath}.orphan.tmp`, '{"partial":', { mode: 0o600 });
  await assert.rejects(requestRemoteWitness({ ...base, fetchImpl: signedFetch(witnessPrivateKey) }), /EEXIST/);
  assert.equal(readFileSync(outputPath, 'utf8'), sentinel);
});


test('remote witness client: orphaned temporary file does not block a fresh atomic publication', async t => {
  const { base, outputPath, witnessPrivateKey } = fixture(t);
  const orphanPath = `${outputPath}.orphan.tmp`;
  const orphanBytes = '{"partial":"crash-before-commit"';
  writeFileSync(orphanPath, orphanBytes, { mode: 0o600 });
  const result = await requestRemoteWitness({ ...base, fetchImpl: signedFetch(witnessPrivateKey) });
  assert.equal(result.valid, true);
  assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).witnessId, 'witness-a');
  assert.equal(readFileSync(orphanPath, 'utf8'), orphanBytes, 'recovery must not guess ownership of or delete an orphan');
});



test('remote witness client: independent processes race safely for one evidence destination', async t => {
  const { base, outputPath, witnessPrivateKey } = fixture(t);
  const dir = dirname(outputPath);
  const privatePath = join(dir, 'witness-private.pem');
  writeFileSync(privatePath, witnessPrivateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const workerPath = fileURLToPath(new URL('../scripts/remote-witness-publication-worker.mjs', import.meta.url));
  const args = [base.historyPath, base.tokenFile, base.publicKeyPath, privatePath, outputPath];
  const runWorker = () => new Promise(resolve => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const results = await Promise.all([runWorker(), runWorker()]);
  assert.equal(results.filter(result => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter(result => result.code !== 0).length, 1, JSON.stringify(results));
  const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(saved.witnessId, 'witness-process-race');
  assert.equal(saved.witnessKeyId, 'process-race-key');
  if (process.platform !== 'win32') assert.equal((statSync(outputPath).mode & 0o777), 0o600);
  const leftovers = readdirSync(dir).filter(name => name.startsWith('evidence.json.') && name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'each process must clean up only its own temporary file');
});

test('remote witness client: invalid signature never commits evidence', async t => {
  const { base, outputPath } = fixture(t);
  const unrelatedSigner = generateKeyPairSync('ed25519');
  await assert.rejects(requestRemoteWitness({ ...base, fetchImpl: signedFetch(unrelatedSigner.privateKey) }), /verification failed/);
  assert.equal(existsSync(outputPath), false);
});

test('remote witness client: successful requests prohibit redirects and use a deadline signal', async t => {
  const { base, witnessPrivateKey } = fixture(t);
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: String(url), redirect: options.redirect, signal: options.signal };
    return signedFetch(witnessPrivateKey)(url, options);
  };
  await requestRemoteWitness({ ...base, fetchImpl });
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.signal instanceof AbortSignal, true);
  assert.equal(captured.signal.aborted, false);
  assert.equal(captured.url, base.endpoint);
});
