import { spawn } from 'node:child_process';

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/**
 * Create a local ClamAV CLI scanner adapter.
 * Requires the ClamAV clamscan executable and a locally maintained signature
 * database. Content is streamed over stdin; no temporary file or shell is used.
 * The caller (ZionClient) owns the scan timeout.
 */
export function createClamAVScanner({ executable = 'clamscan', spawnProcess = spawn } = {}) {
  if (typeof executable !== 'string' || !executable.trim()) throw new TypeError('ClamAV executable must be a non-empty path or command name');
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function');
  return Object.freeze({
    async scan({ content, signal } = {}) {
      if (!Buffer.isBuffer(content)) throw new TypeError('ClamAV scanner content must be a Buffer');
      if (signal?.aborted) throw Object.assign(new Error('ClamAV scan aborted before start'), { code: 'ZION_MALWARE_SCAN_ABORTED' });
      return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let child;
        try {
          child = spawnProcess(executable, [
            '--no-summary', '--stdout',
            '--max-scantime=25000', '--max-filesize=100M', '--max-scansize=200M',
            '--max-files=10000', '--max-recursion=10',
            '--alert-encrypted=yes', '--alert-exceeds-max=yes',
            '-',
          ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (cause) {
          reject(Object.assign(new Error('Unable to start local ClamAV scanner', { cause }), { code: 'ZION_MALWARE_SCANNER_UNAVAILABLE' }));
          return;
        }
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (error) { try { child.kill('SIGKILL'); } catch {} reject(error); }
          else resolve(value);
        };
        const onAbort = () => { child.kill('SIGKILL'); finish(Object.assign(new Error('ClamAV scan aborted'), { code: 'ZION_MALWARE_SCAN_ABORTED' })); };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('error', error => finish(Object.assign(new Error('ClamAV stdout stream failed', { cause: error }), { code: 'ZION_MALWARE_SCANNER_OUTPUT_ERROR' })));
        child.stderr.on('error', error => finish(Object.assign(new Error('ClamAV stderr stream failed', { cause: error }), { code: 'ZION_MALWARE_SCANNER_OUTPUT_ERROR' })));
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          stdout += chunk;
          if (Buffer.byteLength(stdout) > MAX_DIAGNOSTIC_BYTES) { child.kill('SIGKILL'); finish(Object.assign(new Error('ClamAV output exceeded safety limit'), { code: 'ZION_MALWARE_SCAN_OUTPUT_LIMIT' })); }
        });
        child.stderr.on('data', chunk => {
          stderr += chunk;
          if (Buffer.byteLength(stderr) > MAX_DIAGNOSTIC_BYTES) { child.kill('SIGKILL'); finish(Object.assign(new Error('ClamAV diagnostics exceeded safety limit'), { code: 'ZION_MALWARE_SCAN_OUTPUT_LIMIT' })); }
        });
        child.once('error', error => finish(Object.assign(new Error('Unable to start local ClamAV scanner', { cause: error }), { code: 'ZION_MALWARE_SCANNER_UNAVAILABLE' })));
        child.once('close', (code, signalName) => {
          if (settled) return;
          if (code === 0 && /(?:stdin|stream|-): OK\b/i.test(stdout)) finish(null, { verdict: 'clean', engine: 'ClamAV', output: stdout.trim() });
          else if (code === 1 && /FOUND\b/i.test(stdout)) {
            const verdict = /Heuristics\.(?:Encrypted|Limits\.Exceeded)/i.test(stdout) ? 'suspicious' : 'malicious';
            finish(null, { verdict, engine: 'ClamAV', output: stdout.trim() });
          }
          else finish(Object.assign(new Error('ClamAV returned an indeterminate scan result'), { code: 'ZION_MALWARE_SCANNER_ERROR', exitCode: code, signal: signalName, diagnostic: stderr.slice(0, MAX_DIAGNOSTIC_BYTES) }));
        });
        child.stdin.once('error', error => { if (error.code !== 'EPIPE') finish(Object.assign(new Error('Failed to stream content to ClamAV', { cause: error }), { code: 'ZION_MALWARE_SCANNER_INPUT_ERROR' })); });
        if (signal?.aborted) { onAbort(); return; }
        child.stdin.end(content);
      });
    },
  });
}
