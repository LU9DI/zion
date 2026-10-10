import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

export class RustStorageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RustStorageError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Explicit adapter for the optional Rust storage sidecar.
 * The binary must be built from rust-core; this adapter never silently falls back
 * to JavaScript, so operators cannot mistake which implementation is active.
 */
export class RustStorageAdapter {
  constructor({ binaryPath, root, maxChunkBytes, maxStorageBytes, timeoutMs = 5000, spawn = nodeSpawn }) {
    if (typeof binaryPath !== 'string' || binaryPath.trim() === '') throw new TypeError('binaryPath is required');
    if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root is required');
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 33 || maxChunkBytes > 64 * 1024 * 1024) {
      throw new RangeError('maxChunkBytes must be an integer from 33 bytes to 64 MiB');
    }
    if (!Number.isSafeInteger(maxStorageBytes) || maxStorageBytes < maxChunkBytes) {
      throw new RangeError('maxStorageBytes must be at least maxChunkBytes');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new RangeError('timeoutMs must be between 100 and 120000');
    }
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    this.binaryPath = path.resolve(binaryPath);
    this.root = path.resolve(root);
    this.maxChunkBytes = maxChunkBytes;
    this.maxStorageBytes = maxStorageBytes;
    this.timeoutMs = timeoutMs;
    this.spawn = spawn;
  }

  init() { return this.#run('init'); }

  async put(chunkId, envelope) {
    if (typeof chunkId !== 'string' || !SHA256.test(chunkId)) throw new TypeError('chunkId must be lowercase SHA-256 hex');
    if (!Buffer.isBuffer(envelope)) throw new TypeError('envelope must be a Buffer');
    if (envelope.length > this.maxChunkBytes) throw new RangeError('Envelope exceeds configured maximum chunk size');
    const output = await this.#run('put', chunkId, envelope);
    const match = /^OK (\d+) ([01])$/.exec(output.trim());
    if (!match) throw new RustStorageError('INVALID_RESPONSE', 'Rust storage sidecar returned an invalid put receipt');
    const storedBytes = Number(match[1]);
    if (!Number.isSafeInteger(storedBytes) || storedBytes !== envelope.length) {
      throw new RustStorageError('INVALID_RESPONSE', 'Rust storage sidecar receipt byte count does not match the submitted envelope');
    }
    return Object.freeze({ chunkId, bytes: storedBytes, alreadyPresent: match[2] === '1' });
  }

  async get(chunkId) {
    if (typeof chunkId !== 'string' || !SHA256.test(chunkId)) throw new TypeError('chunkId must be lowercase SHA-256 hex');
    const output = await this.#run('get', chunkId, undefined, true);
    if (output.length < 33 || output.length > this.maxChunkBytes || output.subarray(0, 5).toString('ascii') !== 'REAC1') {
      throw new RustStorageError('INVALID_RESPONSE', 'Rust storage sidecar returned an invalid or oversized envelope');
    }
    const actual = createHash('sha256').update(output).digest('hex');
    if (actual !== chunkId) throw new RustStorageError('DIGEST_MISMATCH', 'Rust storage adapter rejected a chunk with the wrong digest');
    return output;
  }

  async usage() {
    const output = await this.#run('usage');
    const value = output.trim();
    if (!/^\d+$/.test(value)) throw new RustStorageError('INVALID_RESPONSE', 'Rust storage sidecar returned invalid usage');
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_SAFE_BYTES) throw new RustStorageError('INVALID_RESPONSE', 'Rust storage usage is outside the safe integer range');
    return Object.freeze({ usedBytes: bytes, quotaBytes: this.maxStorageBytes });
  }

  #run(command, chunkId, stdinBytes, binaryOutput = false) {
    const args = [command, this.root, String(this.maxChunkBytes), String(this.maxStorageBytes)];
    if (chunkId !== undefined) args.push(chunkId);
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawn(this.binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
      catch (error) { reject(new RustStorageError('SIDECAR_START_FAILED', 'Could not start Rust storage sidecar', { cause: error })); return; }
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new RustStorageError('SIDECAR_TIMEOUT', 'Rust storage sidecar timed out'));
      }, this.timeoutMs);
      child.stdout.on('data', chunk => {
        if (settled) return;
        stdoutBytes += chunk.length;
        const maxOutput = binaryOutput ? this.maxChunkBytes : 4096;
        if (stdoutBytes > maxOutput) {
          child.kill('SIGKILL');
          finish(reject, new RustStorageError('SIDECAR_OUTPUT_LIMIT', 'Rust storage sidecar exceeded output limit'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', chunk => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > 4096) {
          child.kill('SIGKILL');
          finish(reject, new RustStorageError('SIDECAR_OUTPUT_LIMIT', 'Rust storage sidecar exceeded stderr output limit'));
          return;
        }
        stderr.push(chunk);
      });
      child.on('error', error => finish(reject, new RustStorageError('SIDECAR_START_FAILED', 'Could not run Rust storage sidecar', { cause: error })));
      child.on('close', code => {
        if (settled) return;
        const out = Buffer.concat(stdout);
        const err = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          const match = /^ERR ([A-Z_]+)(?: (\d+))?$/.exec(err);
          if (match) {
            const details = match[2] ? { availableBytes: Number(match[2]) } : {};
            const messages = {
              CAPACITY_EXHAUSTED: 'Owner-configured storage quota is full',
              INVALID_CHUNK_ID: 'Invalid chunk identifier',
              INVALID_ENVELOPE: 'Invalid encrypted envelope',
              DIGEST_MISMATCH: 'Chunk digest verification failed',
              LOCK_TIMEOUT: 'Timed out waiting for storage lock',
              UNSAFE_PATH: 'Storage path failed safety checks',
              INVALID_CONFIGURATION: 'Invalid Rust storage configuration',
              STORAGE_IO: 'Rust storage I/O failed',
            };
            finish(reject, new RustStorageError(match[1], messages[match[1]] ?? 'Rust storage operation failed', details));
          } else finish(reject, new RustStorageError('SIDECAR_FAILED', 'Rust storage sidecar failed', { exitCode: code, stderr: err.slice(0, 1000) }));
          return;
        }
        finish(resolve, binaryOutput ? out : out.toString('utf8'));
      });
      child.stdin.on('error', () => {});
      if (stdinBytes) child.stdin.end(stdinBytes); else child.stdin.end();
    });
  }
}
