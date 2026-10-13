import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const MAX_INSPECT_BYTES = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readRegularNoFollow(path) {
  let fd;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw Object.assign(new Error('not-regular-file'), { code: 'UNSAFE_FILE' });
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('not-regular-file');
    const metadata = { stat: before };
    if (before.size > MAX_INSPECT_BYTES) return { ...metadata, classification: 'oversized-uninspected', bytesRead: 0 };

    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_INSPECT_BYTES + 1));
    while (total <= MAX_INSPECT_BYTES) {
      const remaining = MAX_INSPECT_BYTES + 1 - total;
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), total);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      total += count;
    }
    const after = fstatSync(fd);
    const bytes = Buffer.concat(chunks, total);
    const changed = before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
    if (changed) return { stat: after, classification: 'changed-during-inspection', bytesRead: total };
    if (total > MAX_INSPECT_BYTES) return { stat: after, classification: 'oversized-uninspected', bytesRead: total };
    return { stat: after, bytes };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Read-only inventory of temporary files created by request-remote-witness.js. */
export function diagnoseWitnessEvidence(outputPath) {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') throw new TypeError('outputPath is required');
  const target = resolve(outputPath);
  const dir = dirname(target);
  const base = basename(target);
  const destination = (() => {
    try { return lstatSync(target); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  })();
  const artifacts = [];

  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(`${base}.`) || !name.endsWith('.tmp')) continue;
    const token = name.slice(base.length + 1, -4);
    if (!UUID.test(token)) continue; // Ignore unrelated/manual files; never infer ownership from a vague suffix.
    const path = resolve(dir, name);
    let entry;
    try {
      const inspected = readRegularNoFollow(path);
      const { stat } = inspected;
      if (inspected.classification) {
        entry = { name, classification: inspected.classification, bytesRead: inspected.bytesRead, mode: (stat.mode & 0o777).toString(8).padStart(3, '0'), note: inspected.classification === 'oversized-uninspected' ? `File exceeds the ${MAX_INSPECT_BYTES}-byte inspection limit; content and hash were not evaluated.` : 'File metadata changed during inspection; content and hash were not evaluated.' };
        artifacts.push(entry);
        continue;
      }
      const { bytes } = inspected;
      let jsonSyntaxValid = false;
      try { JSON.parse(bytes.toString('utf8')); jsonSyntaxValid = true; } catch {}
      const aliasesDestination = Boolean(destination && stat.dev === destination.dev && stat.ino === destination.ino);
      entry = {
        name,
        classification: aliasesDestination ? 'published-alias' : (jsonSyntaxValid ? 'orphan-json-syntax-valid' : 'orphan-invalid-json'),
        bytes: bytes.length,
        mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        jsonSyntaxValid,
        aliasesDestination,
        note: aliasesDestination
          ? 'Same inode as destination; temporary name appears to be a post-publication hard-link alias.'
          : jsonSyntaxValid
            ? 'JSON syntax only; signature, identity, freshness, and trust were not validated. Preserve for operator review.'
            : 'Not valid JSON; preserve for operator review.'
      };
    } catch (error) {
      entry = { name, classification: 'unreadable-or-nonregular', errorCode: error?.code ?? 'INSPECTION_ERROR', note: 'Could not safely inspect without following links; no changes made.' };
    }
    artifacts.push(entry);
  }

  return {
    schemaVersion: 1,
    mode: 'read-only-diagnostic',
    destination: { path: target, exists: Boolean(destination), isRegularFile: Boolean(destination?.isFile()), mode: destination ? (destination.mode & 0o777).toString(8).padStart(3, '0') : null },
    artifactCount: artifacts.length,
    artifacts,
    recoveryPerformed: false,
    maxInspectBytes: MAX_INSPECT_BYTES,
    warning: 'JSON syntax is not proof of valid Witness evidence. Oversized or changing files are not hashed or classified by content. This command never deletes, renames, promotes, or overwrites files.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [outputPath, ...extra] = process.argv.slice(2);
  if (!outputPath || extra.length) {
    console.error('Usage: node scripts/diagnose-witness-evidence.js <evidence-output.json>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(diagnoseWitnessEvidence(outputPath), null, 2)); }
    catch (error) { console.error(`Witness evidence diagnostic failed: ${error.message}`); process.exitCode = 1; }
  }
}
