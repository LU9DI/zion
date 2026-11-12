import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createClamAVScanner } from '../src/clamav-scanner.js';
import { ZionClient } from '../src/zion-client.js';

const version = spawnSync('clamscan', ['--version'], { shell: false, windowsHide: true, encoding: 'utf8' });
const clamavAvailable = !version.error && version.status === 0;

test('real ClamAV detects EICAR and Zion refuses storage', { skip: !clamavAvailable }, async () => {
  const eicar = Buffer.from('X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const scanner = createClamAVScanner();
  const verdict = await scanner.scan({ content: eicar });
  assert.equal(verdict.verdict, 'malicious');

  let writes = 0;
  const client = new ZionClient({
    storageAdapter: { async putChunk() { writes++; }, async getChunk() { throw new Error('not-used'); } },
    malwareScanner: scanner,
    requireMalwareScan: true,
  });
  await assert.rejects(client.upload(eicar), error => error.code === 'ZION_CONTENT_REJECTED' && error.reason === 'malware-malicious');
  assert.equal(writes, 0);
});

test('real ClamAV accepts a harmless fixture when installed', { skip: !clamavAvailable }, async () => {
  const scanner = createClamAVScanner();
  const result = await scanner.scan({ content: Buffer.from('Zion benign integration fixture') });
  assert.equal(result.verdict, 'clean');
});
