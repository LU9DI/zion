import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { createNotificationRecoveryAnchorWitnessChallenge } from '../src/notification-recovery-anchor-witness-challenge.js';

function readHistory(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) throw new Error('History must be a regular file');
    const parsed = JSON.parse(readFileSync(fd, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(NotificationRecoveryAuditAnchor.verifyCheckpointShape)) throw new Error('History must be a non-empty array of valid checkpoint objects');
    return parsed;
  } finally { if (fd !== undefined) closeSync(fd); }
}

const historyPath = process.argv[2];
let ttlMs = 30_000;
if (!historyPath) {
  console.error('Usage: node scripts/create-witness-challenge.js <history.json> [--ttl-ms <1..300000>]');
  process.exitCode = 2;
} else {
  for (let i = 3; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--ttl-ms' || !/^\d+$/.test(process.argv[i + 1] || '')) { console.error(`Unknown or invalid option: ${process.argv[i]}`); process.exitCode = 2; break; }
    ttlMs = Number(process.argv[++i]);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) { console.error('ttl-ms must be an integer from 1 to 300000'); process.exitCode = 2; break; }
  }
  if (!process.exitCode) {
    try {
      const history = readHistory(resolve(historyPath));
      const expectedHistoryHeadSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(history.at(-1));
      const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256, ttlMs });
      process.stdout.write(`${JSON.stringify(challenge, null, 2)}\n`);
    } catch (error) {
      console.error(`${error.code || error.name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
