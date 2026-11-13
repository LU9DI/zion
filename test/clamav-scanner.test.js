import test from 'node:test';
import assert from 'node:assert/strict';
import { createClamAVScanner } from '../src/clamav-scanner.js';
import { EventEmitter } from 'node:events';

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

function fakeChild({ output = '', errorOutput = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => {
      if (output) child.stdout.emit('data', output);
      if (errorOutput) child.stderr.emit('data', errorOutput);
      child.emit('close', code, null);
    });
  };
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test('ClamAV adapter maps an explicit clean result and never invokes a shell', async () => {
  const child = fakeChild({ output: 'stdin: OK\n' });
  let invocation;
  const scanner = createClamAVScanner({ spawnProcess: (...args) => { invocation = args; return child; } });
  const result = await scanner.scan({ content: Buffer.from('safe fixture') });
  assert.equal(result.verdict, 'clean');
  assert.equal(invocation[0], 'clamscan');
  assert.deepEqual(invocation[1], [
    '--no-summary', '--stdout', '--max-scantime=25000', '--max-filesize=100M',
    '--max-scansize=200M', '--max-files=10000', '--max-recursion=10',
    '--alert-encrypted=yes', '--alert-exceeds-max=yes', '-',
  ]);
  assert.equal(invocation[2].shell, false);
});

test('ClamAV adapter maps an explicit infected result to malicious', async () => {
  const child = fakeChild({ output: 'stdin: Eicar-Test-Signature FOUND\n', code: 1 });
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  assert.deepEqual(await scanner.scan({ content: Buffer.from('test fixture') }), { verdict: 'malicious', engine: 'ClamAV', output: 'stdin: Eicar-Test-Signature FOUND' });
});

test('ClamAV adapter fails closed on indeterminate exit codes', async () => {
  const child = fakeChild({ output: 'stdin: ERROR\n', errorOutput: 'database unavailable', code: 2 });
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  await assert.rejects(scanner.scan({ content: Buffer.from('fixture') }), error => error.code === 'ZION_MALWARE_SCANNER_ERROR');
});

test('ClamAV adapter kills the child process when its signal aborts', async () => {
  const child = fakeChild();
  child.stdin.end = () => {};
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  const controller = new AbortController();
  const pending = scanner.scan({ content: Buffer.from('fixture'), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ZION_MALWARE_SCAN_ABORTED');
  assert.equal(child.killed, true);
});

test('ClamAV adapter classifies encrypted and exceeded-limit alerts as suspicious', async () => {
  const child = fakeChild({ output: 'stdin: Heuristics.Limits.Exceeded FOUND\\n', code: 1 });
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  const result = await scanner.scan({ content: Buffer.from('bounded fixture') });
  assert.equal(result.verdict, 'suspicious');
});

test('ClamAV adapter normalizes synchronous process-launch failures', async () => {
  const scanner = createClamAVScanner({ spawnProcess() { throw new Error('spawn denied'); } });
  await assert.rejects(scanner.scan({ content: Buffer.from('fixture') }), error => error.code === 'ZION_MALWARE_SCANNER_UNAVAILABLE');
});

test('ClamAV adapter normalizes synchronous stdin failures and terminates the process', async () => {
  const child = fakeChild();
  child.stdin.end = () => { throw new Error('stdin unavailable'); };
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  await assert.rejects(
    scanner.scan({ content: Buffer.from('fixture') }),
    error => error.code === 'ZION_MALWARE_SCANNER_INPUT_ERROR',
  );
  assert.equal(child.killed, true);
});

test('ClamAV adapter still rejects an aborted scan when process termination throws', async () => {
  const child = fakeChild();
  child.stdin.end = () => {};
  child.kill = () => { throw new Error('process already exited'); };
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  const controller = new AbortController();
  const pending = scanner.scan({ content: Buffer.from('fixture'), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ZION_MALWARE_SCAN_ABORTED');
});

test('ClamAV adapter terminates the process when diagnostic output exceeds its cap', async () => {
  const child = fakeChild({ output: 'x'.repeat(65 * 1024) });
  const scanner = createClamAVScanner({ spawnProcess: () => child });
  await assert.rejects(
    scanner.scan({ content: Buffer.from('fixture') }),
    error => error.code === 'ZION_MALWARE_SCAN_OUTPUT_LIMIT',
  );
  assert.equal(child.killed, true);
});
