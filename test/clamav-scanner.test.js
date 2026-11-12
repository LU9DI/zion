import test from 'node:test';
import assert from 'node:assert/strict';
import { createClamAVScanner } from '../src/clamav-scanner.js';

test('ClamAV adapter rejects invalid input before spawning', async () => {
  const scanner = createClamAVScanner();
  await assert.rejects(scanner.scan({ content: 'not-a-buffer' }), /content must be a Buffer/);
});

test('ClamAV adapter rejects an already-aborted scan before spawning', async () => {
  const scanner = createClamAVScanner();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanner.scan({ content: Buffer.from('fixture'), signal: controller.signal }), error => error.code === 'ZION_MALWARE_SCAN_ABORTED');
});

test('ClamAV adapter reports unavailable executable as a scanner error', async () => {
  const scanner = createClamAVScanner({ executable: 'zion-clamav-executable-that-does-not-exist' });
  await assert.rejects(scanner.scan({ content: Buffer.from('fixture') }), error => error.code === 'ZION_MALWARE_SCANNER_UNAVAILABLE');
});

test('ClamAV adapter validates executable configuration', () => {
  assert.throws(() => createClamAVScanner({ executable: '  ' }), /non-empty path/);
});
