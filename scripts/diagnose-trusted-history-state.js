import { createHash } from 'node:crypto';
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function readBoundedRegularFile(path, limit) {
  let fd;
  try {
    // O_NOFOLLOW is not consistently enforced on Windows; reject symlinks via lstat first.
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw Object.assign(new Error('not a regular non-symlink file'), { code: 'UNSAFE_FILE' });
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('not a regular file');
    if (before.size > limit) throw new Error(`exceeds ${limit}-byte limit`);
    const data = readFileSync(fd);
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || data.length !== after.size) throw new Error('changed during inspection');
    return { data, stat: after };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function inspectState(path) {
  try {
    const { data, stat } = readBoundedRegularFile(path, 16 * 1024);
    const state = JSON.parse(data.toString('utf8'));
    if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.lastRevision) || state.lastRevision < 0 || !/^[a-f0-9]{64}$/.test(state.lastCheckpointSha256) || !Number.isSafeInteger(state.headIssuedAt) || state.headIssuedAt < 0 || typeof state.stateSha256 !== 'string') throw new Error('malformed state schema');
    const { stateSha256, ...body } = state;
    if (sha256(JSON.stringify(body)) !== stateSha256) throw new Error('state checksum mismatch');
    return { status: 'valid', schemaVersion: state.schemaVersion, lastRevision: state.lastRevision, lastCheckpointSha256: state.lastCheckpointSha256, headIssuedAt: state.headIssuedAt, bytes: stat.size, mode: (stat.mode & 0o777).toString(8) };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid-or-unreadable', reason: error.message };
  }
}

function inspectLock(path) {
  try {
    const { data, stat } = readBoundedRegularFile(path, 1024);
    const raw = data.toString('utf8').trim();
    const pid = /^\d+$/.test(raw) ? Number(raw) : null;
    let processStatus = 'unknown';
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); processStatus = 'alive-or-permission-denied'; }
      catch (error) { processStatus = error.code === 'ESRCH' ? 'not-running-on-this-host' : error.code === 'EPERM' ? 'alive-or-permission-denied' : 'unknown'; }
    }
    return { status: 'present', pid, processStatus, bytes: stat.size, mode: (stat.mode & 0o777).toString(8), note: 'PID probing is advisory only; do not remove the lock automatically.' };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent' };
    return { status: 'invalid-or-unreadable', reason: error.message, note: 'Do not modify the lock based on an inconclusive diagnostic.' };
  }
}

export function diagnoseTrustedHistoryState({ statePath }) {
  if (typeof statePath !== 'string' || !statePath.trim()) throw new TypeError('statePath is required');
  const path = resolve(statePath);
  const state = inspectState(path);
  const lock = inspectLock(`${path}.lock`);
  let disposition = 'operator-review-required';
  if (state.status === 'valid' && lock.status === 'absent') disposition = 'state-valid-no-lock';
  else if (state.status === 'missing' && lock.status === 'absent') disposition = 'no-state-no-lock';
  else if (state.status === 'valid' && lock.status === 'present' && lock.processStatus === 'not-running-on-this-host') disposition = 'possible-abandoned-lock-manual-review';
  return { readOnly: true, statePath: path, state, lock, disposition, recoveryGuidance: 'This command never deletes, renames, repairs, or overwrites files. Before manual lock removal, stop writers, verify the PID/host and service manager state, preserve a copy of the lock and state, then retry verification. If state is invalid, do not reset it to make verification pass; restore from an independently trusted backup or investigate.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [statePath, ...rest] = process.argv.slice(2);
  if (!statePath || rest.length) {
    console.error('Usage: npm run anchor:diagnose-trusted-state -- <state-file>');
    process.exitCode = 2;
  } else {
    try {
      const result = diagnoseTrustedHistoryState({ statePath });
      console.log(JSON.stringify(result, null, 2));
      if (result.state.status === 'invalid-or-unreadable' || result.lock.status === 'invalid-or-unreadable') process.exitCode = 1;
    } catch (error) { console.error(`Trusted state diagnostic failed: ${error.message}`); process.exitCode = 1; }
  }
}
