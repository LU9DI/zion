import { readFileSync, openSync, closeSync, fstatSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyUploaderAttributionManifest } from '../src/content-admission-policy.js';
function readBounded(path, limit = 256 * 1024) {
  let fd;
  try { fd = openSync(resolve(path), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); const before = fstatSync(fd); if (!before.isFile() || before.size > limit) throw new Error(`input must be a regular file no larger than ${limit} bytes`); const data = readFileSync(fd); const after = fstatSync(fd); if (data.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('input changed during read'); return data; } finally { if (fd !== undefined) closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, expectedCid] = process.argv.slice(2);
  if (!manifestPath || process.argv.length > 4) { console.error('Usage: npm run content:verify-uploader -- <signed-manifest.json> [expected-cid]'); process.exitCode = 2; }
  else try { const manifest = JSON.parse(readBounded(manifestPath).toString('utf8')); const result = verifyUploaderAttributionManifest(manifest, { expectedCid }); console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1; }
  catch (error) { console.error(`Uploader attribution verification failed: ${error.message}`); process.exitCode = 2; }
}
