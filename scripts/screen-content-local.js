import { readFileSync, openSync, closeSync, fstatSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { screenContentHashLocally } from '../src/content-admission-policy.js';
function readRegular(path, limit) {
  let fd;
  try {
    fd = openSync(resolve(path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error(`input must be a regular file no larger than ${limit} bytes`);
    const data = readFileSync(fd); const after = fstatSync(fd);
    if (data.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('input changed during read');
    return data;
  } finally { if (fd !== undefined) closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [contentPath, blacklistPath] = process.argv.slice(2);
  if (!contentPath || !blacklistPath || process.argv.length > 4) { console.error('Usage: npm run content:screen-local -- <content-file> <blacklist-hashes.json>'); process.exitCode = 2; }
  else try {
    const content = readRegular(contentPath, 64 * 1024 * 1024);
    const blacklist = JSON.parse(readRegular(blacklistPath, 4 * 1024 * 1024).toString('utf8'));
    if (!Array.isArray(blacklist)) throw new Error('blacklist JSON must be an array of SHA-256 hex digests');
    const result = screenContentHashLocally(content, { blacklistSha256: blacklist });
    // Do not print the digest: only a local decision is surfaced.
    console.log(JSON.stringify({ accepted: result.accepted, reason: result.reason, bytes: result.bytes, privacy: result.privacy ?? 'local-only-no-network-disclosure' }, null, 2));
    if (!result.accepted) process.exitCode = 1;
  } catch (error) { console.error(`Local content screening failed: ${error.message}`); process.exitCode = 2; }
}
