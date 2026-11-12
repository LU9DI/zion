import { spawn } from 'node:child_process';
import { mkdtemp, open, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Creates a local ClamAV scanner adapter for ZionClient.
 *
 * Requires ClamAV's clamscan binary and a current signature database on the
 * user's device. The scanner receives a private temporary copy; it never gets
 * Zion's file key and no plaintext is sent to Zion storage peers.
 */
export function createClamAVScanner({
  commandPath = 'clamscan',
  timeoutMs = 30_000,
  maxFileBytes = 256 * 1024 * 1024,
  maxOutputBytes = 64 * 1024,
} = {}) {
  if (typeof commandPath !== 'string' || !commandPath.trim() || commandPath.includes('\0')) {
    throw new TypeError('commandPath must be a non-empty executable path');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10 * 60_000) {
    throw new RangeError('timeoutMs must be between 100 ms and 10 minutes');
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 2 * 1024 * 1024 * 1024) {
    throw new RangeError('maxFileBytes must be between 1 byte and 2 GiB');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024) {
    throw new RangeError('maxOutputBytes must be between 1 KiB and 1 MiB');
  }

  return Object.freeze({
    async scan({ content, sha256, bytes } = {}) {
      if (!Buffer.isBuffer(content) || !Number.isSafeInteger(bytes) || bytes !== content.length ||
          typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
        return { verdict: 'unknown', reason: 'invalid-scan-input' };
      }
      if (content.length > maxFileBytes) return { verdict: 'unknown', reason: 'scanner-size-limit' };

      let directory;
      let fileHandle;
      let child;
      try {
        directory = await mkdtemp(join(tmpdir(), 'zion-clamav-'));
        await chmod(directory, 0o700);
        const filePath = join(directory, `${randomUUID()}.bin`);
        fileHandle = await open(filePath, 'wx', 0o600);
        await fileHandle.writeFile(content);
        await fileHandle.close();
        fileHandle = undefined;

        const result = await new Promise((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          let outputOverflow = false;
          let timedOut = false;
          let settled = false;
          let timer;
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
          };

          try {
            child = spawn(commandPath, ['--no-summary', '--stdout', filePath], {
              shell: false,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (error) {
            finish(error);
            return;
          }

          timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);
          timer.unref?.();

          const capture = (current, chunk, stream) => {
            const next = current + chunk.toString('utf8');
            if (Buffer.byteLength(next) > maxOutputBytes) {
              outputOverflow = true;
              child.kill('SIGKILL');
              return current;
            }
            return next;
          };
          child.stdout.on('data', chunk => { stdout = capture(stdout, chunk, 'stdout'); });
          child.stderr.on('data', chunk => { stderr = capture(stderr, chunk, 'stderr'); });
          child.once('error', error => finish(error));
          child.once('close', (code, signal) => {
            if (timedOut) return finish(new Error('clamav-scan-timeout'));
            if (outputOverflow) return finish(new Error('clamav-output-limit'));
            finish(null, { code, signal, stdout, stderr });
          });
        });

        const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const fileResult = lines.find(line => line.startsWith(`${filePath}:`));
        if (result.code === 0 && fileResult === `${filePath}: OK`) {
          return { verdict: 'clean', engine: 'ClamAV' };
        }
        if (result.code === 1 && fileResult?.endsWith(' FOUND')) {
          return { verdict: 'malicious', engine: 'ClamAV' };
        }
        return { verdict: 'unknown', reason: 'clamav-indeterminate-result' };
      } catch (error) {
        const failure = new Error('clamav-scanner-execution-failed', { cause: error });
        failure.code = 'ZION_CLAMAV_EXECUTION_FAILED';
        throw failure;
      } finally {
        if (fileHandle) await fileHandle.close().catch(() => {});
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  });
}
