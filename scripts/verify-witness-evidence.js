import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicKey } from 'node:crypto';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { verifyNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
function readRegularBounded(path, maxBytes = MAX_FILE_BYTES) {
  let fd;
  const absolutePath = resolve(path);
  try {
    // O_NOFOLLOW is unavailable on some platforms (notably Windows). Reject a
    // symlink before opening, then retain O_NOFOLLOW where the platform supports it.
    const pathStat = lstatSync(absolutePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new Error('Input must be a regular non-symlink file');
    fd = openSync(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Input must be a regular non-symlink file');
    if (before.size > maxBytes) throw new Error(`Input exceeds ${maxBytes}-byte limit`);
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(64 * 1024);
    while (total <= maxBytes) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), total);
      if (!count) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      total += count;
    }
    const after = fstatSync(fd);
    if (total > maxBytes) throw new Error(`Input exceeds ${maxBytes}-byte limit`);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Input changed during inspection');
    return Buffer.concat(chunks, total);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function parseJson(path, label) {
  try { return JSON.parse(readRegularBounded(path).toString('utf8')); }
  catch (error) { throw new Error(`${label}: ${error.message}`); }
}

/** Offline signature and binding verification. This does not prove current freshness or anti-replay. */
export function verifyStoredWitnessEvidence({ evidencePath, publicKeyPath, historyPath, expectedWitnessId, expectedWitnessKeyId, minimumSequence = 1 } = {}) {
  if (![evidencePath, publicKeyPath, historyPath, expectedWitnessId, expectedWitnessKeyId].every(value => typeof value === 'string' && value.trim())) throw new TypeError('Evidence, public key, history, expected witness ID, and expected key ID are required');
  if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 1) throw new TypeError('minimumSequence must be a positive safe integer');
  const evidence = parseJson(evidencePath, 'Evidence');
  const history = parseJson(historyPath, 'History');
  if (!Array.isArray(history) || history.length === 0 || !history.every(NotificationRecoveryAuditAnchor.verifyCheckpointShape)) throw new Error('History must be a non-empty array of valid checkpoint-shaped records');
  const expectedHistoryHeadSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(history.at(-1));
  let publicKey;
  try { publicKey = createPublicKey(readRegularBounded(publicKeyPath, 64 * 1024).toString('utf8')); }
  catch (error) { throw new Error(`Public key: ${error.message}`); }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Public key must use Ed25519');
  // Verify the signed response at its own signed issuance time. This checks signature and
  // challenge-window consistency without pretending an offline check proves freshness now.
  const result = verifyNotificationRecoveryAnchorWitnessChallengeResponse({
    response: evidence,
    publicKey,
    expectedWitnessId,
    expectedWitnessKeyId,
    expectedNonce: evidence?.nonce,
    expectedHistoryHeadSha256,
    now: evidence?.issuedAt,
    maxResponseAgeMs: 30_000,
    minimumSequence,
  });
  if (!result.valid) return { valid: false, code: result.code, mode: 'offline-signature-and-binding-verification', currentFreshnessProven: false };
  return { valid: true, code: result.code, mode: 'offline-signature-and-binding-verification', witnessId: result.witnessId, witnessKeyId: result.witnessKeyId, sequence: result.sequence, issuedAt: result.issuedAt, historyHeadSha256: result.historyHeadSha256, currentFreshnessProven: false, warning: 'Offline verification proves the signed response and its binding to the supplied history head, not current freshness, non-replay, or external trust-registry status.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [evidencePath, publicKeyPath, historyPath, expectedWitnessId, expectedWitnessKeyId, minSequenceText] = process.argv.slice(2);
  if (!evidencePath || !publicKeyPath || !historyPath || !expectedWitnessId || !expectedWitnessKeyId || process.argv.length > 8) {
    console.error('Usage: node scripts/verify-witness-evidence.js <evidence.json> <public-key.pem> <history.json> <witness-id> <key-id> [minimum-sequence]');
    process.exitCode = 2;
  } else {
    try {
      const result = verifyStoredWitnessEvidence({ evidencePath, publicKeyPath, historyPath, expectedWitnessId, expectedWitnessKeyId, minimumSequence: minSequenceText === undefined ? 1 : Number(minSequenceText) });
      console.log(JSON.stringify(result, null, 2));
      if (!result.valid) process.exitCode = 1;
    } catch (error) { console.error(`Witness evidence verification failed: ${error.message}`); process.exitCode = 1; }
  }
}
