import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IntegrityGuard, createIntegrityManifestCore, integrityManifestDigest } from '../src/integrity-guard.js';
import { PeerStorageService } from '../src/peer-storage-service.js';
import { createNodeIdentity } from '../src/peer-security.js';

const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const signedManifest = (releaseVersion, files, privateKey) => {
  const core = createIntegrityManifestCore(releaseVersion, files);
  return Object.freeze({ ...core, signature: sign(null, Buffer.from(canonical(core)), privateKey).toString('base64') });
};

 test('verifies signed release manifest with pinned Ed25519 key', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-integrity-valid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('trusted release artifact');
  await writeFile(path.join(root, 'main.js'), bytes);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = signedManifest('0.32.8', [{ path: 'main.js', sha256: sha256(bytes) }], privateKey);
  const guard = new IntegrityGuard({ root, manifest, trustedPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), expectedReleaseVersion: '0.32.8', requiredPaths: ['main.js'] });
  const report = await guard.verify();
  assert.equal(report.ok, true);
  assert.equal(report.checkedFiles, 1);
  assert.equal(guard.status.verified, true);
  assert.doesNotThrow(() => guard.assertHealthy());
  assert.match(integrityManifestDigest(manifest), /^[a-f0-9]{64}$/);
});

test('verification uses one manifest snapshot even if caller mutates shared configuration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-integrity-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('approved release bytes');
  await writeFile(path.join(root, 'main.js'), bytes);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const core = createIntegrityManifestCore('0.32.8', [{ path: 'main.js', sha256: sha256(bytes) }]);
  const manifest = {
    ...core,
    files: core.files.map(file => ({ ...file })),
    signature: sign(null, Buffer.from(canonical(core)), privateKey).toString('base64')
  };
  const guard = new IntegrityGuard({
    root, manifest,
    trustedPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    expectedReleaseVersion: '0.32.8',
    requiredPaths: ['main.js']
  });
  const verification = guard.verify();
  // verify() must capture the manifest before yielding to filesystem I/O.
  manifest.files[0].sha256 = '0'.repeat(64);
  manifest.files[0].path = '../outside.js';
  const report = await verification;
  assert.equal(report.ok, true);
  assert.equal(report.checkedFiles, 1);
  assert.equal(guard.status.verified, true);
});

test('tampering quarantines the node and blocks critical operations', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-integrity-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = Buffer.from('approved code');
  await writeFile(path.join(root, 'main.js'), original);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = signedManifest('0.32.8', [{ path: 'main.js', sha256: sha256(original) }], privateKey);
  let quarantineNotified = false;
  const guard = new IntegrityGuard({ root, manifest, trustedPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), expectedReleaseVersion: '0.32.8', requiredPaths: ['main.js'], onQuarantine: async () => { quarantineNotified = true; } });
  assert.equal((await guard.verify()).ok, true);
  await writeFile(path.join(root, 'main.js'), 'modified by attacker');
  const report = await guard.reverify();
  assert.equal(report.ok, false);
  assert.match(report.reason, /hash-mismatch/);
  assert.equal(guard.status.quarantined, true);
  assert.equal(quarantineNotified, true);
  assert.throws(() => guard.assertHealthy(), { code: 'ZION_INTEGRITY_QUARANTINED' });
  assert.equal((await guard.verify()).ok, false, 'quarantine cannot be cleared by re-running verify');
});

test('rejects a forged manifest and unexpected symlink paths', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-integrity-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'zion-integrity-outside-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const bytes = Buffer.from('outside');
  await writeFile(path.join(outside, 'target.js'), bytes);
  await symlink(path.join(outside, 'target.js'), path.join(root, 'linked.js'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = signedManifest('0.32.8', [{ path: 'linked.js', sha256: sha256(bytes) }], privateKey);
  const guard = new IntegrityGuard({ root, manifest, trustedPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), expectedReleaseVersion: '0.32.8', requiredPaths: ['linked.js'] });
  const report = await guard.verify();
  assert.equal(report.ok, false);
  assert.match(report.reason, /symlink-not-allowed/);

  const another = await mkdtemp(path.join(tmpdir(), 'zion-integrity-forged-'));
  t.after(() => rm(another, { recursive: true, force: true }));
  await mkdir(path.join(another, 'nested'));
  await writeFile(path.join(another, 'nested', 'main.js'), 'valid file');
  const forged = { ...manifest, releaseVersion: 'attacker-version' };
  const badGuard = new IntegrityGuard({ root: another, manifest: forged, trustedPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), expectedReleaseVersion: '0.32.8', requiredPaths: ['nested/main.js'] });
  assert.equal((await badGuard.verify()).ok, false);
  assert.match(badGuard.status.reason, /release-version-mismatch|invalid-manifest-signature/);
});


test('storage operations fail closed when the integrity guard is quarantined', async () => {
  const guard = { async checkHealthy() { const error = new Error('tampered release'); error.code = 'ZION_INTEGRITY_QUARANTINED'; throw error; }, assertHealthy() { const error = new Error('tampered release'); error.code = 'ZION_INTEGRITY_QUARANTINED'; throw error; } };
  let reads = 0;
  const service = new PeerStorageService({ identity: createNodeIdentity(), store: { async get() { reads++; return Buffer.alloc(0); } }, integrityGuard: guard });
  await assert.rejects(service.handle({ nodeId: 'a'.repeat(64), payload: { type: 'GET_CHUNK', chunkId: 'b'.repeat(64), requestId: 'c'.repeat(32) } }, {}, {}), { code: 'ZION_INTEGRITY_QUARANTINED' });
  assert.equal(reads, 0, 'storage adapter must not be touched after quarantine');
});


test('checkHealthy re-hashes files after the configured interval', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'zion-integrity-periodic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = Buffer.from('approved bytes');
  await writeFile(path.join(root, 'critical.js'), original);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = signedManifest('0.32.8', [{ path: 'critical.js', sha256: sha256(original) }], privateKey);
  const guard = new IntegrityGuard({ root, manifest, trustedPublicKey: publicKey.export({ type: 'spki', format: 'pem' }), expectedReleaseVersion: '0.32.8', requiredPaths: ['critical.js'], verificationIntervalMs: 1000 });
  assert.equal((await guard.verify()).ok, true);
  await writeFile(path.join(root, 'critical.js'), 'altered');
  await new Promise(resolve => setTimeout(resolve, 1010));
  await assert.rejects(guard.checkHealthy(), { code: 'ZION_INTEGRITY_QUARANTINED' });
  assert.equal(guard.status.quarantined, true);
});

test('quarantine zeroes buffered transfer parts and rejects pending downloads', async () => {
  const listeners = new Set();
  const guard = {
    status: { quarantined: false, reason: null },
    async checkHealthy() {},
    assertHealthy() {},
    addQuarantineListener(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const service = new PeerStorageService({ identity: createNodeIdentity(), store: {}, integrityGuard: guard });
  const secretBuffer = Buffer.from('temporary transfer bytes');
  service.transfers.set('peer:transfer:put', { parts: [secretBuffer], totalBytes: secretBuffer.length, expiresAt: Date.now() + 10_000 });
  service.bufferedBytes = secretBuffer.length;
  let pendingRejected = false;
  const pendingPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('test timeout')), 5000);
    service.pendingGets.set('peer:request', { timeout, reject: error => { pendingRejected = true; clearTimeout(timeout); reject(error); } });
  });
  for (const listener of listeners) await listener({ reason: 'hash-mismatch:src/peer-storage-service.js' });
  await assert.rejects(pendingPromise, /hash-mismatch/);
  assert.equal(pendingRejected, true);
  assert.equal(secretBuffer.every(byte => byte === 0), true, 'in-memory transfer part should be overwritten');
  assert.equal(service.transfers.size, 0);
  assert.equal(service.bufferedBytes, 0);
  assert.equal(service.pendingGets.size, 0);
});

test('send and fetch operations check integrity before touching the transport', async () => {
  let sends = 0;
  const guard = { async checkHealthy() { const error = new Error('quarantined'); error.code = 'ZION_INTEGRITY_QUARANTINED'; throw error; }, assertHealthy() { throw new Error('quarantined'); } };
  const service = new PeerStorageService({ identity: createNodeIdentity(), store: {}, integrityGuard: guard });
  const transport = { send() { sends++; } };
  const socket = { destroyed: false, writable: true };
  await assert.rejects(service.sendStoreChunk(transport, socket, Buffer.alloc(40), 'a'.repeat(64), () => ({})), { code: 'ZION_INTEGRITY_QUARANTINED' });
  await assert.rejects(service.fetchChunk(transport, socket, 'a'.repeat(64), 'b'.repeat(64)), { code: 'ZION_INTEGRITY_QUARANTINED' });
  assert.equal(sends, 0);
});
