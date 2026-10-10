import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWitnessTempMetadata, recoverWitnessTemporaries, stageWitnessTemporary } from '../src/witness-temp-recovery.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zion-witness-temp-recovery-'));
  const stagingDir = join(root, 'staging'); const quarantineDir = join(root, 'orphans', 'discarded');
  mkdirSync(stagingDir, { recursive: true }); mkdirSync(join(root, 'published'), { recursive: true });
  const keys = generateKeyPairSync('ed25519'); const publisherKeys = new Map([['publisher-A', keys.publicKey]]);
  const opts = { root, stagingDir, quarantineDir, auditPath: join(root, 'audit.jsonl'), publisherKeys, isSessionValid: () => true, now: Date.now() };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function stage({ id = randomUUID(), bytes = Buffer.from('recovered payload'), state = 'READY_FOR_COMMIT', fsynced = true, targetPath = `published/${id}.bin`, signer = keys.privateKey, publisherId = 'publisher-A', tokenId = 'session-1', sessionNonce = randomUUID() } = {}) {
    const temp = join(stagingDir, `${id}.tmp`); const metaPath = join(stagingDir, `${id}.meta`);
    const fd = openSync(temp, 'wx', 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const metadata = createWitnessTempMetadata({ publisherId, sessionNonce, sessionTimestamp: opts.now, targetPath, targetHash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, state, fsynced, privateKey: signer, tokenId });
    const mfd = openSync(metaPath, 'wx', 0o600); try { writeFileSync(mfd, `${JSON.stringify(metadata)}\n`); fsyncSync(mfd); } finally { closeSync(mfd); }
    return { id, temp, metaPath, target: join(root, targetPath), bytes, metadata };
  }
  return { ...opts, keys, stage };
}

test('publisher staging helper fsyncs and creates signed metadata consumed by recovery', t => {
  const f = fixture(t); const bytes = Buffer.from('publisher-path-payload');
  const staged = stageWitnessTemporary({ root: f.root, stagingDir: f.stagingDir, bytes, publisherId: 'publisher-A', sessionNonce: randomUUID(), sessionTimestamp: f.now, tokenId: 'session-1', targetPath: 'published/from-helper.bin', privateKey: f.keys.privateKey });
  assert.equal(staged.byteLength, bytes.length);
  assert.equal(staged.metadata.state, 'READY_FOR_COMMIT');
  assert.equal(staged.metadata.fsynced, true);
  assert.equal(recoverWitnessTemporaries(f).recovered, 1);
  assert.deepEqual(readFileSync(join(f.root, 'published/from-helper.bin')), bytes);
});

test('publisher staging helper rejects staging directory outside data root', t => {
  const f = fixture(t);
  assert.throws(() => stageWitnessTemporary({ root: f.root, stagingDir: tmpdir(), bytes: Buffer.from('x'), publisherId: 'publisher-A', sessionNonce: randomUUID(), targetPath: 'published/x', privateKey: f.keys.privateKey }), /child of root/);
});

test('recovers only signed, fsynced READY_FOR_COMMIT orphan and records audit event', t => {
  const f = fixture(t); const s = f.stage();
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 1); assert.equal(result.quarantined, 0);
  assert.deepEqual(readFileSync(s.target), s.bytes);
  assert.equal(readdirSync(f.stagingDir).length, 0);
  assert.match(readFileSync(f.auditPath, 'utf8'), /Recovered Orphaned Commit/);
});

test('recovery is idempotent when run twice', t => {
  const f = fixture(t); f.stage();
  assert.equal(recoverWitnessTemporaries(f).recovered, 1);
  const second = recoverWitnessTemporaries(f);
  assert.equal(second.recovered, 0); assert.equal(second.quarantined, 0);
});

test('invalid signature is quarantined and never promoted', t => {
  const f = fixture(t); const attacker = generateKeyPairSync('ed25519'); const s = f.stage({ signer: attacker.privateKey });
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 0); assert.equal(result.quarantined, 1);
  assert.equal((awaitlessExists(s.target)), false);
  assert.ok(readdirSync(f.quarantineDir).length >= 2);
});

function awaitlessExists(path) { try { readFileSync(path); return true; } catch { return false; } }

test('revoked session is quarantined rather than repaired', t => {
  const f = fixture(t); const s = f.stage();
  const result = recoverWitnessTemporaries({ ...f, isSessionValid: () => false });
  assert.equal(result.recovered, 0); assert.equal(result.quarantined, 1); assert.equal(awaitlessExists(s.target), false);
});

test('hash mismatch and non-ready metadata fail closed', t => {
  const f = fixture(t); const tampered = f.stage({ id: 'tamper' });
  writeFileSync(tampered.temp, 'changed after signature');
  f.stage({ id: 'staging-state', state: 'STAGING', fsynced: false });
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 0); assert.equal(result.quarantined, 2);
});

test('existing destination is preserved and orphan goes to forensic quarantine', t => {
  const f = fixture(t); const s = f.stage({ id: 'collision' });
  writeFileSync(s.target, 'newer official content', { flag: 'wx' });
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 0); assert.equal(result.quarantined, 1);
  assert.equal(readFileSync(s.target, 'utf8'), 'newer official content');
  assert.equal(readdirSync(f.stagingDir).length, 0);
});

test('temporary without sidecar and sidecar without temporary are both quarantined', t => {
  const f = fixture(t);
  writeFileSync(join(f.stagingDir, 'bare.tmp'), 'unowned');
  writeFileSync(join(f.stagingDir, 'meta-only.meta'), '{broken');
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 0); assert.equal(result.quarantined, 2);
});

test('target traversal cannot be signed for recovery and its partial staging file is quarantined', t => {
  const f = fixture(t);
  const temp = join(f.stagingDir, 'escape.tmp'); writeFileSync(temp, 'uncommitted');
  assert.throws(() => createWitnessTempMetadata({ publisherId: 'publisher-A', sessionNonce: randomUUID(), sessionTimestamp: f.now, targetPath: '../escape.bin', targetHash: createHash('sha256').update('uncommitted').digest('hex'), byteLength: 11, state: 'READY_FOR_COMMIT', fsynced: true, privateKey: f.keys.privateKey }), /safe relative path/);
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 0); assert.equal(result.quarantined, 1);
});

test('SIGKILL after durable staging leaves a signed orphan recoverable on restart', async t => {
  const f = fixture(t);
  const id = 'sigkill-orphan';
  const bytes = Buffer.from('durable-before-crash');
  const privateKeyPem = f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const moduleUrl = new URL('../src/witness-temp-recovery.js', import.meta.url).href;
  const worker = `
    import { createHash } from 'node:crypto';
    import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
    import { join } from 'node:path';
    import { createWitnessTempMetadata } from ${JSON.stringify(moduleUrl)};
    const root = process.env.ZION_ROOT, id = process.env.ZION_ID;
    const bytes = Buffer.from(process.env.ZION_BYTES, 'base64');
    const dir = join(root, 'staging');
    const fd = openSync(join(dir, id + '.tmp'), 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    const meta = createWitnessTempMetadata({ publisherId: 'publisher-A', sessionNonce: process.env.ZION_NONCE, sessionTimestamp: Number(process.env.ZION_NOW), targetPath: 'published/sigkill-recovered.bin', targetHash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, state: 'READY_FOR_COMMIT', fsynced: true, privateKey: process.env.ZION_PRIVATE_KEY, tokenId: 'crash-session' });
    const mfd = openSync(join(dir, id + '.meta'), 'wx', 0o600);
    try { writeFileSync(mfd, JSON.stringify(meta) + '\\n'); fsyncSync(mfd); } finally { closeSync(mfd); }
    process.stdout.write('STAGED');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
    env: { ...process.env, ZION_ROOT: f.root, ZION_ID: id, ZION_BYTES: bytes.toString('base64'), ZION_NONCE: randomUUID(), ZION_NOW: String(f.now), ZION_PRIVATE_KEY: privateKeyPem },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('STAGED')) { child.kill('SIGKILL'); resolve(); }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== 'SIGKILL' && !output.includes('STAGED')) reject(new Error(`worker exited early: ${code}/${signal}`));
    });
  });
  await new Promise(resolve => child.once('exit', resolve));
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 1);
  assert.deepEqual(readFileSync(join(f.root, 'published/sigkill-recovered.bin')), bytes);
});

test('two recovery processes racing for one destination never overwrite committed bytes', async t => {
  const f = fixture(t);
  const staged = f.stage({ id: 'parallel-recovery', bytes: Buffer.from('single-winner') });
  const publicKeyPem = f.keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const moduleUrl = new URL('../src/witness-temp-recovery.js', import.meta.url).href;
  const worker = `
    import { createPublicKey } from 'node:crypto';
    import { recoverWitnessTemporaries } from ${JSON.stringify(moduleUrl)};
    const root = process.env.ZION_ROOT;
    const publicKey = createPublicKey(process.env.ZION_PUBLIC_KEY);
    const result = recoverWitnessTemporaries({ root, stagingDir: root + '/staging', quarantineDir: root + '/orphans/discarded', auditPath: root + '/audit.jsonl', publisherKeys: new Map([['publisher-A', publicKey]]), isSessionValid: () => true, now: Number(process.env.ZION_NOW) });
    process.stdout.write(JSON.stringify(result));
  `;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { env: { ...process.env, ZION_ROOT: f.root, ZION_PUBLIC_KEY: publicKeyPem, ZION_NOW: String(f.now) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => { out += b.toString(); }); child.stderr.on('data', b => { err += b.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `recovery worker exit ${code}`)));
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(readFileSync(staged.target, 'utf8'), 'single-winner');
  assert.equal(results.reduce((n, r) => n + r.recovered, 0), 1);
  assert.ok(results.every(r => r.recovered >= 0));
});


test('replay ledger persists nonce use across separate recovery runs', t => {
  const f = fixture(t);
  const nonce = randomUUID();
  const first = f.stage({ id: 'nonce-first', sessionNonce: nonce, targetPath: 'published/first.bin' });
  const second = f.stage({ id: 'nonce-replay', sessionNonce: nonce, targetPath: 'published/second.bin' });
  const firstRun = recoverWitnessTemporaries(f);
  assert.equal(firstRun.recovered, 1);
  assert.deepEqual(readFileSync(first.target), first.bytes);
  assert.equal(awaitlessExists(second.target), false);
  assert.ok(readdirSync(f.quarantineDir).length >= 2);
  const ledger = JSON.parse(readFileSync(join(f.root, '.witness-replay-ledger.json'), 'utf8'));
  assert.equal(ledger.schemaVersion, 1);
  assert.equal(Object.values(ledger.entries).filter(entry => entry.status === 'COMMITTED').length, 1);
});

test('corrupt persistent replay ledger fails closed before scanning staging', t => {
  const f = fixture(t);
  const staged = f.stage();
  writeFileSync(join(f.root, '.witness-replay-ledger.json'), '{corrupt');
  assert.throws(() => recoverWitnessTemporaries(f), /replay ledger is corrupt/);
  assert.equal(awaitlessExists(staged.target), false);
  assert.equal(awaitlessExists(staged.temp), true);
});

test('resumes cleanup after crash between atomic target link and staging cleanup', t => {
  const f = fixture(t);
  const staged = f.stage({ id: 'crash-after-link' });
  writeFileSync(staged.target, staged.bytes, { flag: 'wx' });
  writeFileSync(join(f.root, '.witness-replay-ledger.json'), JSON.stringify({
    schemaVersion: 1,
    entries: {
      [`${staged.metadata.publisherId}:${staged.metadata.sessionNonce}`]: {
        metadataId: staged.metadata.metadataId,
        status: 'RESERVED',
        targetPath: staged.metadata.targetPath,
        targetHash: staged.metadata.targetHash,
      },
    },
  }) + '\n');
  const result = recoverWitnessTemporaries(f);
  assert.equal(result.recovered, 1);
  assert.equal(result.quarantined, 0);
  assert.equal(readFileSync(staged.target, 'utf8'), staged.bytes.toString());
  assert.equal(readdirSync(f.stagingDir).length, 0);
  const ledger = JSON.parse(readFileSync(join(f.root, '.witness-replay-ledger.json'), 'utf8'));
  assert.equal(Object.values(ledger.entries)[0].status, 'COMMITTED');
});
