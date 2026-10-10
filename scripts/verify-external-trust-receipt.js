import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyExternalTrustAnchorReceipt } from '../src/external-trust-anchor-receipt.js';

function readBounded(path, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(resolve(path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error(`Input must be a regular file of at most ${maxBytes} bytes`);
    const value = readFileSync(fd);
    const after = fstatSync(fd);
    if (value.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Input changed during inspection');
    return value;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function readJson(path) { return JSON.parse(readBounded(path).toString('utf8')); }

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [receiptPath, publicKeyPath, authorityId, revisionText, checkpointSha256, minSequenceText, maxAgeText] = process.argv.slice(2);
  if (!receiptPath || !publicKeyPath || !authorityId || revisionText === undefined || !checkpointSha256 || process.argv.length > 9) {
    console.error('Usage: node scripts/verify-external-trust-receipt.js <receipt.json> <authority-public-key.pem> <authority-id> <revision> <checkpoint-sha256> [minimum-sequence] [max-age-ms]'); process.exitCode = 2;
  } else {
    try {
      const revision = Number(revisionText); const minimumSequence = minSequenceText === undefined ? 1 : Number(minSequenceText); const maxAgeMs = maxAgeText === undefined ? 60_000 : Number(maxAgeText);
      const result = verifyExternalTrustAnchorReceipt({ receipt: readJson(receiptPath), publicKey: readBounded(publicKeyPath, 64 * 1024).toString('utf8'), expectedAuthorityId: authorityId, expectedRevision: revision, expectedCheckpointSha256: checkpointSha256, minimumSequence, maxAgeMs, now: Date.now() });
      console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1;
    } catch (error) { console.error(`External trust receipt verification failed: ${error.message}`); process.exitCode = 1; }
  }
}
