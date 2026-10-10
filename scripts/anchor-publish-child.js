import { PersistentFileNotificationAnchorAdapter } from '../src/notification-recovery-file-anchor-adapter.js';

const [anchorPath, encodedCheckpoint, timeoutText = '3000'] = process.argv.slice(2);
if (!anchorPath || !encodedCheckpoint) {
  process.stderr.write('Usage: anchor-publish-child.js <anchorPath> <checkpoint-base64> [timeoutMs]\n');
  process.exit(2);
}
const checkpoint = JSON.parse(Buffer.from(encodedCheckpoint, 'base64').toString('utf8'));
const adapter = new PersistentFileNotificationAnchorAdapter({ anchorPath, lockTimeoutMs: Number(timeoutText), retryIntervalMs: 5 });
try {
  const result = await adapter.publish(checkpoint);
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'UNKNOWN', message: error.message }) + '\n');
  process.exitCode = 1;
}
