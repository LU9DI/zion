import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fsyncSync, lstatSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { NotificationRecoveryIndependentAnchor } from '../src/notification-recovery-independent-anchor.js';
import { PersistentFileNotificationAnchorAdapter } from '../src/notification-recovery-file-anchor-adapter.js';

const issuedAt = Date.parse('2026-10-09T12:00:00.000Z');
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'zion-file-anchor-'));
  const anchorPath = join(dir, 'independent', 'checkpoint.json');
  const keys = generateKeyPairSync('ed25519');
  const adapter = new PersistentFileNotificationAnchorAdapter({ anchorPath, lockTimeoutMs: 100, retryIntervalMs: 2 });
  const client = new NotificationRecoveryIndependentAnchor({ adapter, publicKey: keys.publicKey, expectedSignerKeyId: 'anchor', now: () => issuedAt });
  const registryPath = join(dir, 'registry.json');
  const state = { schemaVersion: 1, revision: 0, keys: {}, events: [] };
  state.stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  const first = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath, signerKeyId: 'anchor', privateKey: keys.privateKey, issuedAt });
  return { dir, anchorPath, keys, adapter, client, first };
}

test('persists checkpoint durably and can read it after adapter recreation', async () => {
  const ctx = setup();
  assert.equal((await ctx.client.publish(ctx.first)).published, true);
  const recreated = new PersistentFileNotificationAnchorAdapter({ anchorPath: ctx.anchorPath });
  assert.deepEqual(await recreated.getLatest(), ctx.first);
  assert.equal((await new NotificationRecoveryIndependentAnchor({ adapter: recreated, publicKey: ctx.keys.publicKey, expectedSignerKeyId: 'anchor', now: () => issuedAt }).verifyLatest()).valid, true);
  assert.equal((lstatSync(ctx.anchorPath).mode & 0o777), 0o600);
});

test('concurrent identical publications serialize and are idempotent', async () => {
  const ctx = setup();
  const results = await Promise.all([ctx.client.publish(ctx.first), ctx.client.publish(ctx.first)]);
  assert.equal(results.filter(result => result.published).length, 1);
  assert.equal(results.filter(result => result.idempotent).length, 1);
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
});


test('creates the anchor lock with private permissions before durable publication', async () => {
  const ctx = setup();
  let inspected = false;
  const adapter = new PersistentFileNotificationAnchorAdapter({
    anchorPath: ctx.anchorPath,
    _fsyncSync(fd) {
      if (!inspected) {
        inspected = true;
        const lockPath = `${ctx.anchorPath}.lock`;
        const stat = lstatSync(lockPath);
        assert.equal(stat.isFile(), true);
        assert.equal(stat.mode & 0o777, 0o600);
        assert.equal(JSON.parse((awaitlessReadFile)(lockPath, 'utf8')).pid, process.pid);
      }
      return fsyncSync(fd);
    },
  });
  assert.deepEqual(await adapter.publish(ctx.first), { stored: true, idempotent: false });
  assert.equal(inspected, true, 'lock fsync must occur after exclusive creation');
});

const { readFileSync: awaitlessReadFile } = await import('node:fs');

test('does not steal a pre-existing lock and fails closed on timeout', async () => {
  const ctx = setup();
  mkdirSync(join(ctx.dir, 'independent'), { recursive: true });
  writeFileSync(`${ctx.anchorPath}.lock`, 'owned by another process');
  await assert.rejects(ctx.adapter.publish(ctx.first), error => error.code === 'NOTIFICATION_ANCHOR_LOCK_TIMEOUT');
  assert.equal(await ctx.adapter.getLatest(), null);
});

test('refuses symbolic-link checkpoint files', async () => {
  const ctx = setup();
  mkdirSync(join(ctx.dir, 'independent'), { recursive: true });
  const target = join(ctx.dir, 'target.json');
  writeFileSync(target, JSON.stringify(ctx.first));
  symlinkSync(target, ctx.anchorPath);
  await assert.rejects(ctx.adapter.getLatest(), error => error.code === 'NOTIFICATION_ANCHOR_UNSAFE_FILE');
});

test('rejects a conflicting checkpoint instead of overwriting stored anchor', async () => {
  const ctx = setup();
  await ctx.client.publish(ctx.first);
  const forked = { ...ctx.first, registryStateSha256: 'c'.repeat(64) };
  await assert.rejects(ctx.adapter.publish(forked), error => error.code === 'NOTIFICATION_ANCHOR_CONFLICT');
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
});


const workerPath = fileURLToPath(new URL('../scripts/anchor-publish-child.js', import.meta.url));
function publishInChild(anchorPath, checkpoint, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, anchorPath, Buffer.from(JSON.stringify(checkpoint)).toString('base64'), String(timeoutMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      try {
        const result = JSON.parse(stdout.trim());
        resolve({ exitCode: code, ...result, stderr });
      } catch (error) {
        reject(new Error(`Child returned invalid output (exit ${code}): ${stdout} ${stderr}`, { cause: error }));
      }
    });
  });
}

test('independent Node processes serialize identical checkpoint publication', async () => {
  const ctx = setup();
  const results = await Promise.all([
    publishInChild(ctx.anchorPath, ctx.first),
    publishInChild(ctx.anchorPath, ctx.first),
  ]);
  assert.ok(results.every(result => result.exitCode === 0 && result.ok), JSON.stringify(results));
  assert.equal(results.filter(result => result.result.idempotent).length, 1);
  assert.equal(results.filter(result => !result.result.idempotent).length, 1);
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
});

test('independent processes cannot overwrite each other with same-revision forks', async () => {
  const ctx = setup();
  const forked = { ...ctx.first, registryStateSha256: 'd'.repeat(64) };
  const results = await Promise.all([
    publishInChild(ctx.anchorPath, ctx.first),
    publishInChild(ctx.anchorPath, forked),
  ]);
  assert.equal(results.filter(result => result.exitCode === 0 && result.ok).length, 1, JSON.stringify(results));
  const rejected = results.find(result => !result.ok);
  assert.ok(rejected, JSON.stringify(results));
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.code, 'NOTIFICATION_ANCHOR_CONFLICT');
  assert.equal(rejected.result, undefined);
  const stored = await ctx.adapter.getLatest();
  assert.ok([ctx.first.registryStateSha256, forked.registryStateSha256].includes(stored.registryStateSha256));
});


test('fails closed when a publisher process dies and leaves its lock behind', async () => {
  const ctx = setup();
  mkdirSync(join(ctx.dir, 'independent'), { recursive: true });
  const lockPath = `${ctx.anchorPath}.lock`;
  const script = `const fs = require('node:fs'); const p = process.argv[1]; const fd = fs.openSync(p, 'wx', 0o600); fs.writeSync(fd, JSON.stringify({pid: process.pid, acquiredAt: Date.now()})); fs.fsyncSync(fd); fs.closeSync(fd); process.exit(23);`;
  const child = spawnSync(process.execPath, ['-e', script, lockPath], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(lstatSync(lockPath).isFile(), true);
  const conservativeAdapter = new PersistentFileNotificationAnchorAdapter({ anchorPath: ctx.anchorPath, lockTimeoutMs: 30, retryIntervalMs: 5 });
  await assert.rejects(conservativeAdapter.publish(ctx.first), error => error.code === 'NOTIFICATION_ANCHOR_LOCK_TIMEOUT');
  assert.equal(lstatSync(lockPath).isFile(), true, 'stale lock must not be silently removed');
  assert.equal(await conservativeAdapter.getLatest(), null);
});

test('ignores orphaned temporary checkpoints after an interrupted pre-rename write', async () => {
  const ctx = setup();
  const directory = join(ctx.dir, 'independent');
  mkdirSync(directory, { recursive: true });
  const orphan = `${ctx.anchorPath}.tmp-previous-process-abandoned`;
  writeFileSync(orphan, '{"partial":');

  assert.equal(await ctx.adapter.getLatest(), null, 'uncommitted temporary data must not be treated as the latest checkpoint');
  const result = await ctx.adapter.publish(ctx.first);
  assert.deepEqual(result, { stored: true, idempotent: false });
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
  assert.equal(lstatSync(orphan).isFile(), true, 'unknown temporary files are preserved for forensic inspection');
});

test('reports corrupt committed checkpoint and never silently replaces it', async () => {
  const ctx = setup();
  mkdirSync(join(ctx.dir, 'independent'), { recursive: true });
  writeFileSync(ctx.anchorPath, '{"truncated":');
  await assert.rejects(ctx.adapter.getLatest(), error => error.code === 'NOTIFICATION_ANCHOR_CORRUPT');
  await assert.rejects(ctx.adapter.publish(ctx.first), error => error.code === 'NOTIFICATION_ANCHOR_CORRUPT');
  assert.equal((await import('node:fs')).readFileSync(ctx.anchorPath, 'utf8'), '{"truncated":');
});

test('survives an actual publisher process crash after partial temporary-file creation', async () => {
  const ctx = setup();
  const directory = join(ctx.dir, 'independent');
  mkdirSync(directory, { recursive: true });
  const orphan = `${ctx.anchorPath}.tmp-crashed-child-partial`;
  const script = `const fs = require('node:fs'); const p = process.argv[1]; const fd = fs.openSync(p, 'wx', 0o600); fs.writeSync(fd, '{\\"schemaVersion\\":'); fs.fsyncSync(fd); fs.closeSync(fd); process.exit(29);`;
  const child = spawnSync(process.execPath, ['-e', script, orphan], { encoding: 'utf8' });
  assert.equal(child.status, 29, child.stderr);
  assert.equal((await ctx.adapter.getLatest()), null, 'partial temporary file must not become committed state');
  const published = await ctx.adapter.publish(ctx.first);
  assert.deepEqual(published, { stored: true, idempotent: false });
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
  assert.equal((await import('node:fs')).readFileSync(orphan, 'utf8'), '{"schemaVersion":', 'partial forensic evidence must remain untouched');
});

test('reports visible-but-unconfirmed state when directory sync fails after rename, then confirms on retry', async () => {
  const ctx = setup();
  let syncCalls = 0;
  const injected = new PersistentFileNotificationAnchorAdapter({
    anchorPath: ctx.anchorPath,
    lockTimeoutMs: 100,
    retryIntervalMs: 2,
    _fsyncSync(fd) {
      syncCalls += 1;
      // lock fsync = 1, checkpoint file fsync = 2, parent directory fsync = 3.
      if (syncCalls === 3) {
        const error = new Error('injected directory fsync failure');
        error.code = 'EIO';
        throw error;
      }
      return (awaitlessFsync)(fd);
    },
  });
  await assert.rejects(injected.publish(ctx.first), error => error.code === 'NOTIFICATION_ANCHOR_DURABILITY_UNCONFIRMED');
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first, 'atomic rename made the checkpoint visible before directory sync failed');
  const retry = await injected.publish(ctx.first);
  assert.deepEqual(retry, { stored: true, idempotent: true });
  assert.ok(syncCalls >= 6, `expected retry to fsync the file and directory, saw ${syncCalls} fsync calls`);
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
});

const { fsyncSync: awaitlessFsync } = await import('node:fs');


test('reports lock-release failure after a successful durable publication', async () => {
  const ctx = setup();
  const adapter = new PersistentFileNotificationAnchorAdapter({
    anchorPath: ctx.anchorPath,
    _unlinkSync(path) {
      if (path === `${ctx.anchorPath}.lock`) {
        const error = new Error('injected lock release failure');
        error.code = 'EIO';
        throw error;
      }
      return awaitlessUnlink(path);
    },
  });
  await assert.rejects(adapter.publish(ctx.first), error => error.code === 'NOTIFICATION_ANCHOR_LOCK_RELEASE_FAILED');
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first, 'checkpoint can be visible even though lock cleanup failed');
  assert.equal(lstatSync(`${ctx.anchorPath}.lock`).isFile(), true, 'failed cleanup must leave evidence of the lock');
});

test('preserves the primary publication error when lock release also fails', async () => {
  const ctx = setup();
  const adapter = new PersistentFileNotificationAnchorAdapter({
    anchorPath: ctx.anchorPath,
    _unlinkSync(path) {
      if (path === `${ctx.anchorPath}.lock`) {
        const error = new Error('injected lock release failure');
        error.code = 'EIO';
        throw error;
      }
      return awaitlessUnlink(path);
    },
  });
  await ctx.adapter.publish(ctx.first);
  const forked = { ...ctx.first, registryStateSha256: 'e'.repeat(64) };
  await assert.rejects(adapter.publish(forked), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause.code, 'NOTIFICATION_ANCHOR_CONFLICT');
    assert.equal(error.errors[1].code, 'NOTIFICATION_ANCHOR_LOCK_RELEASE_FAILED');
    return true;
  });
  assert.deepEqual(await ctx.adapter.getLatest(), ctx.first);
});

const { unlinkSync: awaitlessUnlink } = await import('node:fs');


test('does not unlink a lock file that was replaced after acquisition', async () => {
  const ctx = setup();
  let replaced = false;
  const adapter = new PersistentFileNotificationAnchorAdapter({
    anchorPath: ctx.anchorPath,
    _fsyncSync(fd) {
      if (!replaced) {
        replaced = true;
        // Simulate an out-of-band operator replacing the path while this process holds its fd.
        const lockPath = `${ctx.anchorPath}.lock`;
        (awaitlessUnlink)(lockPath);
        writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now(), token: 'replacement-owner' }), { mode: 0o600 });
      }
      return awaitlessFsync(fd);
    },
  });
  await assert.rejects(adapter.publish(ctx.first), error => error.code === 'NOTIFICATION_ANCHOR_LOCK_OWNERSHIP_LOST');
  const replacement = JSON.parse((await import('node:fs')).readFileSync(`${ctx.anchorPath}.lock`, 'utf8'));
  assert.equal(replacement.token, 'replacement-owner');
});
