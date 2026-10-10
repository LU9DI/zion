import { constants as fsConstants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyTrustedCheckpointHistory } from './verify-trusted-checkpoint-history.js';
import { persistTrustedHistoryState } from './persist-trusted-history-state.js';

function readJson(path, label, limit = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(resolve(path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Input must be a regular non-symlink file');
    if (before.size > limit) throw new Error(`Input exceeds ${limit}-byte limit`);
    const chunks = []; let total = 0; const buffer = Buffer.alloc(64 * 1024);
    while (total <= limit) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - total), total); if (!n) break; chunks.push(Buffer.from(buffer.subarray(0, n))); total += n; }
    const after = fstatSync(fd);
    if (total > limit) throw new Error(`Input exceeds ${limit}-byte limit`);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Input changed during inspection');
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const [historyPath, trustPolicyPath, transitionsPath, revocationsPath, revocationAuthorityKeyPath] = args;
  let rollbackPolicyPath; let statePath;
  for (let i = 5; i < args.length; i += 1) {
    if (args[i] === '--state-file' && args[i + 1]) { statePath = args[++i]; }
    else if (args[i] === '--rollback-policy' && args[i + 1]) { rollbackPolicyPath = args[++i]; }
    else if (!args[i].startsWith('--') && !rollbackPolicyPath) rollbackPolicyPath = args[i];
    else { console.error(`Unknown or incomplete argument: ${args[i]}`); process.exitCode = 2; break; }
  }
  if (!process.exitCode && (!historyPath || !trustPolicyPath || !transitionsPath || !revocationsPath || !revocationAuthorityKeyPath || args.length < 5)) {
    console.error('Usage: node scripts/verify-trusted-checkpoint-history-cli.js <history.json> <trust-policy.json> <rotations.json> <revocations.json> <revocation-authority-public-key.pem> [rollback-policy.json] [--state-file trust-state.json]'); process.exitCode = 2;
  } else if (!process.exitCode) {
    try {
      const result = verifyTrustedCheckpointHistory({ checkpoints: readJson(historyPath, 'History'), trustPolicy: readJson(trustPolicyPath, 'Trust policy', 256 * 1024), transitions: readJson(transitionsPath, 'Rotations', 1024 * 1024), revocations: readJson(revocationsPath, 'Revocations', 1024 * 1024), revocationAuthorityPublicKey: readJsonText(revocationAuthorityKeyPath), rollbackPolicy: rollbackPolicyPath ? readJson(rollbackPolicyPath, 'Rollback policy', 64 * 1024) : undefined, now: Date.now() });
      if (result.valid && statePath) result.persistedTrustState = persistTrustedHistoryState({ statePath, verification: result });
      console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1;
    } catch (error) { console.error(`Trusted checkpoint history verification failed: ${error.message}`); process.exitCode = 1; }
  }
}
function readJsonText(path) {
  let fd;
  try { fd = openSync(resolve(path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Public key must be a regular file of at most 65536 bytes'); const buffer = Buffer.alloc(stat.size + 1); const n = readSync(fd, buffer, 0, buffer.length, 0); const after = fstatSync(fd); if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || n !== stat.size) throw new Error('Public key changed during inspection'); return buffer.subarray(0, n).toString('utf8'); } finally { if (fd !== undefined) closeSync(fd); }
}
