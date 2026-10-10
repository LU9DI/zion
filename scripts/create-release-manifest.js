#!/usr/bin/env node
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Manifest numbers must be safe non-negative integers'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new TypeError('Unsupported manifest value');
};
const fail = message => { console.error(message); process.exitCode = 1; };

const [releaseVersion, ...paths] = process.argv.slice(2);
const keyPath = process.env.ZION_RELEASE_SIGNING_KEY;
if (!releaseVersion || paths.length === 0 || !keyPath) {
  fail('Usage: ZION_RELEASE_SIGNING_KEY=/offline/key.pem node scripts/create-release-manifest.js <version> <relative-file>...');
} else {
  try {
    const privateKey = createPrivateKey(await readFile(keyPath));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must be Ed25519');
    const seen = new Set();
    const files = [];
    for (const relative of paths) {
      if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || seen.has(relative)) throw new Error(`Unsafe or duplicate release path: ${relative}`);
      seen.add(relative);
      const bytes = await readFile(path.resolve(process.cwd(), relative));
      files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const core = { version: 1, releaseVersion, files };
    const signature = sign(null, Buffer.from(canonical(core)), privateKey).toString('base64');
    await writeFile('zion-release-manifest.json', `${JSON.stringify({ ...core, signature }, null, 2)}\n`, { mode: 0o600 });
    console.log(`Wrote signed manifest for ${files.length} files: zion-release-manifest.json`);
    console.log('Keep the private key offline; provision the matching public key independently and pin it in deployment configuration.');
  } catch (error) { fail(`Unable to create release manifest: ${error.message}`); }
}
