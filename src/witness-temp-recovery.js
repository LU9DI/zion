import {
  createHash, sign as cryptoSign, verify as cryptoVerify, randomUUID,
} from 'node:crypto';
import {
  closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync,
  linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync, readFileSync as readFileSync2,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const STATES = new Set(['STAGING', 'SYNCED', 'READY_FOR_COMMIT']);
const HASH_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[a-f0-9-]{32,64}$/i;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function signedPayload(meta) {
  const { signature, ...payload } = meta;
  return Buffer.from(canonical(payload));
}
function fsyncDirectory(path) {
  // Node.js cannot portably fsync directory handles on Windows: opening a directory
  // and calling fsyncSync commonly fails with EPERM. File contents and metadata files
  // are still fsynced individually before publication. Windows does not receive the
  // same directory-entry crash-durability guarantee as POSIX filesystems here.
  if (process.platform === 'win32') return;
  const fd = openSync(path, fsConstants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function regularFile(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('not a regular file');
  return st;
}
function safeTarget(root, targetPath) {
  if (typeof targetPath !== 'string' || !targetPath || isAbsolute(targetPath)) throw new Error('targetPath must be a relative path');
  const target = resolve(root, targetPath);
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('targetPath escapes or aliases the data root');
  let cursor = resolve(root);
  for (const part of rel.split(sep).slice(0, -1)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('target path traverses a symlink');
  }
  return target;
}

/** Create a signed sidecar. The caller must only set fsynced=true after fsyncSync(dataFd) succeeds. */
export function createWitnessTempMetadata({ publisherId, sessionNonce, sessionTimestamp = Date.now(), targetPath, targetHash, byteLength, state = 'READY_FOR_COMMIT', fsynced = false, privateKey, tokenId = null }) {
  if (typeof publisherId !== 'string' || !publisherId.trim() || publisherId.length > 256) throw new Error('publisherId is required');
  if (typeof sessionNonce !== 'string' || !NONCE_RE.test(sessionNonce)) throw new Error('sessionNonce must be a high-entropy nonce');
  if (!Number.isSafeInteger(sessionTimestamp) || sessionTimestamp < 0) throw new Error('sessionTimestamp is invalid');
  if (typeof targetPath !== 'string' || !targetPath || isAbsolute(targetPath) || targetPath.split(/[\\/]/).includes('..')) throw new Error('targetPath must be a safe relative path');
  if (!HASH_RE.test(targetHash ?? '') || !Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('target hash or byteLength is invalid');
  if (!STATES.has(state) || (state === 'READY_FOR_COMMIT' && fsynced !== true)) throw new Error('state/fsync combination is not recoverable');
  const metadata = { schemaVersion: 1, publisherId, sessionNonce, sessionTimestamp, tokenId, targetPath, targetHash, byteLength, state, fsynced, metadataId: randomUUID() };
  metadata.signature = cryptoSign(null, signedPayload(metadata), privateKey).toString('base64');
  return metadata;
}

/**
 * Durably stage a publication using the same signed format consumed by recovery.
 * The data file is fsynced before its signed sidecar can assert fsynced=true;
 * both directory entries are then synced before the function returns.
 * This helper does not publish the target: recovery owns the no-replace commit.
 */
export function stageWitnessTemporary({ root, stagingDir, bytes, publisherId, sessionNonce, sessionTimestamp = Date.now(), tokenId = null, targetPath, privateKey }) {
  if (!root || !stagingDir || !(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) throw new Error('root, stagingDir and byte buffer are required');
  const dataRoot = resolve(root); const staging = resolve(stagingDir);
  const rel = relative(dataRoot, staging);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === '') throw new Error('stagingDir must be a child of root');
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  // Reject symlinked staging directories and all existing staging path components.
  let cursor = dataRoot;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('stagingDir cannot traverse symlinks');
  }
  const id = randomUUID(); const tempPath = resolve(staging, `${id}.tmp`); const metaPath = resolve(staging, `${id}.meta`);
  const content = Buffer.from(bytes);
  const fd = openSync(tempPath, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } catch (error) { try { unlinkSync(tempPath); } catch {} throw error; } finally { closeSync(fd); }
  fsyncDirectory(staging);
  try {
    const metadata = createWitnessTempMetadata({
      publisherId, sessionNonce, sessionTimestamp, tokenId, targetPath,
      targetHash: sha256(content), byteLength: content.length,
      state: 'READY_FOR_COMMIT', fsynced: true, privateKey,
    });
    const metaFd = openSync(metaPath, 'wx', 0o600);
    try { writeFileSync(metaFd, `${JSON.stringify(metadata)}\n`); fsyncSync(metaFd); } finally { closeSync(metaFd); }
    fsyncDirectory(staging);
    return { id, tempPath, metaPath, metadata, byteLength: content.length, targetHash: metadata.targetHash };
  } catch (error) {
    // Do not silently delete an orphan: leave it for the signed recovery scanner to quarantine.
    throw error;
  }
}

/**
 * Recover signed Witness staging files. No unsigned/invalid item is ever promoted.
 * options: {root, stagingDir, quarantineDir, auditPath, publisherKeys, isSessionValid, now, maxSessionAgeMs}
 */
function recoverWitnessTemporariesUnlocked({ root, stagingDir, quarantineDir, auditPath, publisherKeys, isSessionValid = () => false, now = Date.now(), maxSessionAgeMs = 15 * 60_000, replayLedgerPath } = {}) {
  if (!root || !stagingDir || !quarantineDir || !auditPath || !(publisherKeys instanceof Map)) throw new Error('root, stagingDir, quarantineDir, auditPath and publisherKeys Map are required');
  const dataRoot = resolve(root); const staging = resolve(stagingDir); const quarantine = resolve(quarantineDir);
  const within = p => { const r = relative(dataRoot, p); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
  if (!within(staging) || !within(quarantine) || !within(resolve(auditPath))) throw new Error('staging, quarantine and audit path must be inside root');
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  const events = [];
  const ledgerPath = resolve(replayLedgerPath || resolve(dataRoot, '.witness-replay-ledger.json'));
  if (!within(ledgerPath)) throw new Error('replay ledger must be inside root');
  let replayLedger = Object.create(null);
  if (existsSync(ledgerPath)) {
    let parsed;
    try { parsed = JSON.parse(readFileSync2(ledgerPath, 'utf8')); }
    catch { throw new Error('replay ledger is corrupt; refusing recovery'); }
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) throw new Error('replay ledger is corrupt; refusing recovery');
    replayLedger = parsed.entries;
  }
  const persistLedger = () => {
    const tempPath = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tempPath, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, entries: replayLedger }) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tempPath, ledgerPath); fsyncDirectory(dirname(ledgerPath));
  };
  const emit = (event, fields = {}) => {
    const record = { schemaVersion: 1, event, at: new Date(now).toISOString(), ...fields };
    const fd = openSync(auditPath, 'a', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    events.push(record);
  };
  const quarantineItem = (paths, reason, id) => {
    const moved = [];
    for (const p of paths.filter(Boolean)) {
      if (!existsSync(p)) continue;
      const dest = resolve(quarantine, `${Date.now()}-${id}-${moved.length}-${p.split(sep).at(-1)}`);
      try { renameSync(p, dest); moved.push(dest); } catch { /* leave item in place and report fail-closed */ }
    }
    fsyncDirectory(quarantine);
    emit('Witness temporary quarantined', { id, reason, files: moved.map(p => relative(dataRoot, p)) });
  };
  const names = readdirSync(staging).sort();
  const temps = names.filter(n => n.endsWith('.tmp'));
  const pairedMeta = new Set();
  for (const name of temps) {
    const temp = resolve(staging, name); const metaPath = `${temp.slice(0, -4)}.meta`; const id = name.slice(0, -4);
    if (!existsSync(metaPath)) { quarantineItem([temp], 'missing-metadata', id); continue; }
    pairedMeta.add(metaPath);
    try {
      regularFile(temp); regularFile(metaPath);
      const bytes = readFileSync(temp); const rawMeta = readFileSync(metaPath);
      if (rawMeta.length > 64 * 1024) throw new Error('metadata-too-large');
      const meta = JSON.parse(rawMeta.toString('utf8'));
      if (meta.schemaVersion !== 1 || !STATES.has(meta.state) || meta.state !== 'READY_FOR_COMMIT' || meta.fsynced !== true) throw new Error('not-ready-or-not-fsynced');
      const publicKey = publisherKeys.get(meta.publisherId);
      if (!publicKey || typeof meta.signature !== 'string' || !cryptoVerify(null, signedPayload(meta), publicKey, Buffer.from(meta.signature, 'base64'))) throw new Error('invalid-publisher-signature');
      if (!NONCE_RE.test(meta.sessionNonce ?? '') || !Number.isSafeInteger(meta.sessionTimestamp) || meta.sessionTimestamp > now + 30_000 || now - meta.sessionTimestamp > maxSessionAgeMs) throw new Error('expired-or-invalid-session');
      const nonceKey = `${meta.publisherId}:${meta.sessionNonce}`;
      const priorUse = replayLedger[nonceKey];
      if (priorUse && priorUse.metadataId !== meta.metadataId) throw new Error('replayed-session-nonce');
      if (!isSessionValid({ publisherId: meta.publisherId, sessionNonce: meta.sessionNonce, sessionTimestamp: meta.sessionTimestamp, tokenId: meta.tokenId })) throw new Error('session-revoked-or-invalid');
      if (bytes.length !== meta.byteLength || sha256(bytes) !== meta.targetHash) throw new Error('temporary-content-hash-mismatch');
      const target = safeTarget(dataRoot, meta.targetPath);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // Persist nonce reservation before commit. Same metadata may resume after a crash; a different record cannot reuse it.
      if (!priorUse) { replayLedger[nonceKey] = { metadataId: meta.metadataId, status: 'RESERVED', targetPath: meta.targetPath, targetHash: meta.targetHash }; persistLedger(); }
      if (existsSync(target)) {
        // Resume the narrow crash window after link(target) but before staging cleanup.
        const targetStat = regularFile(target);
        const targetBytes = readFileSync(target);
        if (priorUse?.metadataId === meta.metadataId && targetStat.size === meta.byteLength && sha256(targetBytes) === meta.targetHash) {
          unlinkSync(temp); unlinkSync(metaPath); fsyncDirectory(staging);
          replayLedger[nonceKey] = { ...replayLedger[nonceKey], status: 'COMMITTED' }; persistLedger();
          emit('Recovered Orphaned Commit', { id, publisherId: meta.publisherId, sessionNonce: meta.sessionNonce, targetPath: meta.targetPath, targetHash: meta.targetHash, byteLength: meta.byteLength, resumedAfterCrash: true });
          continue;
        }
        quarantineItem([temp, metaPath], 'destination-already-exists', id); continue;
      }
      // linkSync is an atomic no-replace commit. A publisher racing recovery wins or loses, never overwrites.
      try { linkSync(temp, target); }
      catch (error) {
        if (error.code === 'EEXIST') { quarantineItem([temp, metaPath], 'destination-race-conflict', id); continue; }
        throw error;
      }
      fsyncDirectory(dirname(target));
      unlinkSync(temp); unlinkSync(metaPath); fsyncDirectory(staging);
      replayLedger[nonceKey] = { ...replayLedger[nonceKey], status: 'COMMITTED' }; persistLedger();
      emit('Recovered Orphaned Commit', { id, publisherId: meta.publisherId, sessionNonce: meta.sessionNonce, targetPath: meta.targetPath, targetHash: meta.targetHash, byteLength: meta.byteLength });
    } catch (error) {
      quarantineItem([temp, metaPath], error.message || 'validation-failed', id);
    }
  }
  for (const name of names.filter(n => n.endsWith('.meta'))) {
    const path = resolve(staging, name);
    if (!pairedMeta.has(path) && existsSync(path)) quarantineItem([path], 'metadata-without-temporary', name.slice(0, -5));
  }
  fsyncDirectory(staging);
  return { scanned: temps.length, events, recovered: events.filter(e => e.event === 'Recovered Orphaned Commit').length, quarantined: events.filter(e => e.event === 'Witness temporary quarantined').length };
}


/** Cross-process serialized recovery. The lock is exclusive; a live lock fails closed. */
export function recoverWitnessTemporaries(options = {}) {
  const { root } = options;
  if (!root) throw new Error('root is required');
  const dataRoot = resolve(root);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const lockPath = resolve(dataRoot, '.witness-recovery.lock');
  let lockFd;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (lockFd === undefined) {
    try { lockFd = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Reclaim only a parseable lock whose owner process is demonstrably gone.
      try {
        const lock = JSON.parse(readFileSync2(lockPath, 'utf8'));
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (probeError) { if (probeError.code === 'ESRCH') alive = false; }
        if (!alive) { unlinkSync(lockPath); continue; }
      } catch (probeError) {
        if (probeError.code === 'ENOENT') continue;
        // A malformed lock is not silently removed: manual inspection is safer.
      }
      if (Date.now() >= deadline) throw new Error('witness recovery lock is busy or stale; refusing concurrent scan');
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  try {
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n');
    fsyncSync(lockFd);
    return recoverWitnessTemporariesUnlocked(options);
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockPath); fsyncDirectory(dataRoot); } catch { /* preserve fail-closed state if lock cleanup fails */ }
  }
}
