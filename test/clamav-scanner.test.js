import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClamAVScanner } from '../src/clamav-scanner.js';
import { ZionClient, MemoryCiphertextAdapter } from '../src/zion-client.js';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');

async function fakeClamAV(t, { mode = 'clean' } = {}) {
  if (process.platform === 'win32') {
    t.skip('POSIX executable fixture is not portable to Windows');
    return null;
  }
  const directory = await mkdtemp(join(tmpdir(), 'zion-fake-clamav-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'clamscan');
  const modeLiteral = JSON.stringify(mode);
  const body = '#!/usr/bin/env node\n' +
    'const path = process.argv.at(-1);\n' +
    'const mode = ' + modeLiteral + ';\n' +
    "if (mode === 'timeout') setTimeout(() => process.exit(0), 2000);\n" +
    "else if (mode === 'error') { console.error('engine error'); process.exit(2); }\n" +
    "else if (mode === 'malicious') { console.log(path + ': Eicar-Test-Signature FOUND'); process.exit(1); }\n" +
    "else { console.log(path + ': OK'); process.exit(0); }\n";
  await writeFile(executable, body, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test('ClamAV adapter accepts only an explicit clean result', async t => {
  const executable = await fakeClamAV(t);
  if (!executable) return;
  const scanner = createClamAVScanner({ commandPath: executable });
  const content = Buffer.from('safe test fixture');
  const result = await scanner.scan({ content, sha256: digest(content), bytes: content.length });
  assert.deepEqual(result, { verdict: 'clean', engine: 'ClamAV' });
});

test('ClamAV adapter marks a detected signature as malicious', async t => {
  const executable = await fakeClamAV(t, { mode: 'malicious' });
  if (!executable) return;
  const scanner = createClamAVScanner({ commandPath: executable });
  const content = Buffer.from('malware test fixture');
  const result = await scanner.scan({ content, sha256: digest(content), bytes: content.length });
  assert.deepEqual(result, { verdict: 'malicious', engine: 'ClamAV' });
});

test('ClamAV engine errors never produce a clean verdict', async t => {
  const executable = await fakeClamAV(t, { mode: 'error' });
  if (!executable) return;
  const scanner = createClamAVScanner({ commandPath: executable });
  const content = Buffer.from('fixture');
  await assert.rejects(scanner.scan({ content, sha256: digest(content), bytes: content.length }), /clamav-scanner-execution-failed/);
});

test('ClamAV timeout fails closed', async t => {
  const executable = await fakeClamAV(t, { mode: 'timeout' });
  if (!executable) return;
  const scanner = createClamAVScanner({ commandPath: executable, timeoutMs: 100 });
  const content = Buffer.from('fixture');
  await assert.rejects(scanner.scan({ content, sha256: digest(content), bytes: content.length }), /clamav-scanner-execution-failed/);
});

test('ClamAV adapter rejects oversized and malformed inputs as unknown', async () => {
  const scanner = createClamAVScanner({ maxFileBytes: 4 });
  const content = Buffer.from('12345');
  assert.deepEqual(await scanner.scan({ content, sha256: digest(content), bytes: content.length }), {
    verdict: 'unknown',
    reason: 'scanner-size-limit',
  });
  assert.deepEqual(await scanner.scan({ content, sha256: 'invalid', bytes: content.length }), {
    verdict: 'unknown',
    reason: 'invalid-scan-input',
  });
});

test('ClamAV adapter can be required by ZionClient and blocks malicious content before storage', async t => {
  const executable = await fakeClamAV(t, { mode: 'malicious' });
  if (!executable) return;
  const adapter = new MemoryCiphertextAdapter();
  const client = new ZionClient({
    storageAdapter: adapter,
    malwareScanner: createClamAVScanner({ commandPath: executable }),
    requireMalwareScan: true,
  });
  await assert.rejects(client.upload(Buffer.from('test payload')), error =>
    error.code === 'ZION_CONTENT_REJECTED' && error.reason === 'malware-malicious');
  assert.equal(adapter.size, 0);
});
