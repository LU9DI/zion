import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const schemaVersion = 1;

function readState(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('Persisted trust state must be a regular file of at most 16384 bytes');
    const data = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('Persisted trust state changed during inspection');
    const state = JSON.parse(data);
    if (!state || state.schemaVersion !== schemaVersion || !Number.isSafeInteger(state.lastRevision) || state.lastRevision < 0 || !/^[a-f0-9]{64}$/.test(state.lastCheckpointSha256) || !Number.isSafeInteger(state.headIssuedAt) || state.headIssuedAt < 0 || typeof state.stateSha256 !== 'string') throw new Error('Persisted trust state is malformed');
    const { stateSha256, ...body } = state;
    if (sha256(JSON.stringify(body)) !== stateSha256) throw new Error('Persisted trust state checksum mismatch');
    return state;
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Persist a monotonic local pin after successful verification. Protect this file and its directory independently. */
export function persistTrustedHistoryState({ statePath, verification }) {
  if (typeof statePath !== 'string' || !statePath.trim()) throw new TypeError('statePath is required');
  if (!verification?.valid || !Number.isSafeInteger(verification.lastRevision) || !/^[a-f0-9]{64}$/.test(verification.lastCheckpointSha256) || !Number.isSafeInteger(verification.headIssuedAt)) throw new TypeError('Only a successful, complete history verification can update trust state');
  const path = resolve(statePath); const dir = dirname(path); mkdirSync(dir, { recursive: true });
  const lockPath = `${path}.lock`; let lockFd; let lockAcquired = false;
  try {
    lockFd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600); lockAcquired = true;
    writeFileSync(lockFd, `${process.pid}\n`); fsyncSync(lockFd);
    let current;
    try { if (existsSync(path)) current = readState(path); } catch (error) { throw new Error(`Cannot trust existing state: ${error.message}`); }
    if (current && verification.lastRevision < current.lastRevision) throw new Error('Verified history rollback detected: revision is below persisted trust state');
    if (current && verification.lastRevision === current.lastRevision && verification.lastCheckpointSha256 !== current.lastCheckpointSha256) throw new Error('Verified history fork detected: same revision has a different checkpoint hash');
    if (current && verification.headIssuedAt < current.headIssuedAt) throw new Error('Verified history timestamp rollback detected');
    if (current && verification.lastRevision === current.lastRevision) return { updated: false, state: current };
    const body = { schemaVersion, lastRevision: verification.lastRevision, lastCheckpointSha256: verification.lastCheckpointSha256, headIssuedAt: verification.headIssuedAt };
    const state = { ...body, stateSha256: sha256(JSON.stringify(body)) };
    const temp = join(dir, `.${basename(path)}.${process.pid}.${sha256(`${Date.now()}-${Math.random()}`).slice(0, 12)}.tmp`);
    let tempFd;
    try {
      tempFd = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      writeFileSync(tempFd, `${JSON.stringify(state)}\n`); fsyncSync(tempFd); closeSync(tempFd); tempFd = undefined;
      renameSync(temp, path);
      // Node.js cannot portably fsync directory handles on Windows (EPERM).
      // The state file is fsynced before rename; Windows directory-entry durability is weaker.
      if (process.platform !== 'win32') {
        const dirFd = openSync(dir, fsConstants.O_RDONLY);
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
    } catch (error) {
      if (tempFd !== undefined) closeSync(tempFd);
      try { unlinkSync(temp); } catch {}
      throw error;
    }
    return { updated: true, state };
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    if (lockAcquired) { try { unlinkSync(lockPath); } catch {} }
  }
}
