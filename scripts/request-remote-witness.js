import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createPublicKey } from 'node:crypto';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { createNotificationRecoveryAnchorWitnessChallenge, verifyNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

function readRegular(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) throw new Error('Input must be a regular file');
    return readFileSync(fd);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function readHistory(path) {
  const parsed = JSON.parse(readRegular(path).toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(NotificationRecoveryAuditAnchor.verifyCheckpointShape)) throw new Error('History must be a non-empty array of valid checkpoints');
  return parsed;
}
function readToken(path, clientId) {
  const raw = readRegular(path).toString('utf8').trim();
  let token = raw;
  if (raw.startsWith('{')) {
    const doc = JSON.parse(raw);
    if (doc.schemaVersion !== 1 || !Array.isArray(doc.clients) || !clientId) throw new Error('JSON credential file requires --client-id and schemaVersion 1');
    const client = doc.clients.find(item => item?.id === clientId && item.enabled === true);
    if (!client || typeof client.token !== 'string') throw new Error('Enabled client credential not found');
    token = client.token;
  }
  if (Buffer.byteLength(token) < 32 || /[\r\n]/.test(token)) throw new Error('Token must be at least 32 bytes and contain no line breaks');
  return token;
}
function syncDirectory(path) {
  // Directory-handle fsync is not portable in Node.js on Windows (EPERM).
  // File data is fsynced before publication; Windows directory-entry durability is weaker.
  if (process.platform === 'win32') return;
  const dirFd = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function writeNewPrivateJson(path, value) {
  const target = resolve(path);
  const tmp = `${target}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    // Commit atomically without replacement: the complete, fsynced inode becomes visible
    // at the destination in one link operation. A crash cannot expose a partially-written target.
    // linkSync also fails with EEXIST, preserving any prior evidence.
    linkSync(tmp, target);
    syncDirectory(dirname(target));
    unlinkSync(tmp);
    syncDirectory(dirname(target));
  } catch (error) {
    // Once linked, do not roll back the target: the commit may already be durable and
    // deleting it after a directory-sync error could destroy valid evidence.
    throw error;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
  }
}

export async function requestRemoteWitness({ endpoint, historyPath, tokenFile, publicKeyPath, expectedWitnessId, expectedWitnessKeyId, outputPath, clientId, fetchImpl = fetch, now = Date.now() } = {}) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/v1/witness/challenge') throw new Error('Endpoint must be an HTTP(S) URL ending exactly in /v1/witness/challenge, without credentials, query, or fragment');
  if (url.protocol !== 'https:' && !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) throw new Error('Plain HTTP is permitted only for loopback witness endpoints');
  if (!expectedWitnessId || !expectedWitnessKeyId || !outputPath) throw new Error('Expected witness ID, key ID, and output path are required');
  const history = readHistory(resolve(historyPath));
  const expectedHistoryHeadSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(history.at(-1));
  const challenge = createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256, now });
  const token = readToken(resolve(tokenFile), clientId);
  const keyText = readRegular(resolve(publicKeyPath)).toString('utf8');
  const publicKey = createPublicKey(keyText);
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(challenge) });
  if (!response.ok) throw new Error(`Witness request failed with HTTP ${response.status}`);
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new Error('Witness response is not JSON');
  const responseBody = await response.text();
  if (Buffer.byteLength(responseBody) > 16 * 1024) throw new Error('Witness response exceeds 16 KiB');
  let signedResponse;
  try { signedResponse = JSON.parse(responseBody); } catch { throw new Error('Witness response contains invalid JSON'); }
  const verification = verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response: signedResponse, publicKey, expectedWitnessId, expectedWitnessKeyId, expectedNonce: challenge.nonce, expectedHistoryHeadSha256, now: Date.now() });
  if (!verification.valid) throw new Error(`Witness response verification failed: ${verification.code}`);
  writeNewPrivateJson(outputPath, signedResponse);
  return { valid: true, witnessId: verification.witnessId, witnessKeyId: verification.witnessKeyId, sequence: verification.sequence, historyHeadSha256: verification.historyHeadSha256, outputPath: resolve(outputPath) };
}

const args = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [endpoint, historyPath, tokenFile, publicKeyPath, expectedWitnessId, expectedWitnessKeyId, outputPath, clientId] = args;
  if (!endpoint || !historyPath || !tokenFile || !publicKeyPath || !expectedWitnessId || !expectedWitnessKeyId || !outputPath || args.length > 8) {
    console.error('Usage: node scripts/request-remote-witness.js <endpoint> <history.json> <token-file> <public-key.pem> <witness-id> <key-id> <output.json> [client-id]');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await requestRemoteWitness({ endpoint, historyPath, tokenFile, publicKeyPath, expectedWitnessId, expectedWitnessKeyId, outputPath, clientId }), null, 2)); }
    catch (error) { console.error(`Remote witness request failed: ${error.message}`); process.exitCode = 1; }
  }
}
