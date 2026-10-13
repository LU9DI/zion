import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-crash-boundary-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signer = generateKeyPairSync('ed25519');
  const registryPath = join(dir, 'registry.json');
  const state = { schemaVersion: 1, revision: 1, keys: {}, events: [] };
  state.stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  const checkpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath, signerKeyId: 'crash-test', privateKey: signer.privateKey });
  const historyPath = join(dir, 'history.json');
  writeFileSync(historyPath, JSON.stringify([checkpoint]));
  const witness = generateKeyPairSync('ed25519');
  const publicKeyPath = join(dir, 'witness-public.pem');
  writeFileSync(publicKeyPath, witness.publicKey.export({ type: 'spki', format: 'pem' }));
  const privateKeyPath = join(dir, 'witness-private.pem');
  writeFileSync(privateKeyPath, witness.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 't'.repeat(48), { mode: 0o600 });
  return { dir, historyPath, publicKeyPath, privateKeyPath, tokenFile, outputPath: join(dir, 'evidence.json') };
}

function runCrashWorker(f, mode) {
  const injector = fileURLToPath(new URL('../scripts/test-fixtures/witness-crash-injector.mjs', import.meta.url));
  const worker = fileURLToPath(new URL('../scripts/remote-witness-publication-worker.mjs', import.meta.url));
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(injector).href, worker, f.historyPath, f.tokenFile, f.publicKeyPath, f.privateKeyPath, f.outputPath], {
      env: { ...process.env, ZION_TEST_CRASH_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('Witness publication crash before atomic link leaves no destination and does not expose partial evidence', async t => {
  const f = fixture(t);
  const result = await runCrashWorker(f, 'before-link');
  assert.equal(process.platform === 'win32' ? result.code : result.signal, process.platform === 'win32' ? 137 : 'SIGKILL', JSON.stringify(result));
  assert.equal(existsSync(f.outputPath), false, 'destination must remain absent before commit');
  const leftovers = readdirSync(f.dir).filter(name => name.startsWith('evidence.json.') && name.endsWith('.tmp'));
  assert.equal(leftovers.length, 1, 'hard-killed process may leave its uniquely named temporary file');
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.dir, leftovers[0]), 'utf8')), 'temporary file is complete and fsynced before the commit point');
});

test('Witness publication crash immediately after atomic link leaves complete evidence and may leave an orphan alias', async t => {
  const f = fixture(t);
  const result = await runCrashWorker(f, 'after-link');
  assert.equal(result.signal, 'SIGKILL', JSON.stringify(result));
  assert.equal(existsSync(f.outputPath), true, 'link commit makes the complete target visible');
  const saved = JSON.parse(readFileSync(f.outputPath, 'utf8'));
  assert.equal(saved.witnessId, 'witness-process-race');
  assert.equal((statSync(f.outputPath).mode & 0o777), 0o600);
  const leftovers = readdirSync(f.dir).filter(name => name.startsWith('evidence.json.') && name.endsWith('.tmp'));
  assert.equal(leftovers.length, 1, 'crash can leave the temporary hard-link alias');
  assert.equal(readFileSync(join(f.dir, leftovers[0]), 'utf8'), readFileSync(f.outputPath, 'utf8'), 'both names refer to complete identical bytes');
});

test('Witness directory-fsync failure reports uncertainty but never rolls back committed evidence', async t => {
  const f = fixture(t);
  const result = await runCrashWorker(f, 'directory-fsync-error');
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.match(result.stderr, /injected directory fsync failure/);
  assert.equal(existsSync(f.outputPath), true, 'committed evidence must not be deleted after directory fsync failure');
  const saved = JSON.parse(readFileSync(f.outputPath, 'utf8'));
  assert.equal(saved.witnessId, 'witness-process-race');
  assert.deepEqual(readdirSync(f.dir).filter(name => name.startsWith('evidence.json.') && name.endsWith('.tmp')), [], 'normal exception cleanup removes only its own temporary alias');
});
