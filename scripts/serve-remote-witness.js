import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, openSync, closeSync, fstatSync, constants as fsConstants, writeFileSync, renameSync, unlinkSync, mkdirSync, rmdirSync, existsSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, createPrivateKey, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createNotificationRecoveryAnchorWitnessChallengeResponse } from '../src/notification-recovery-anchor-witness-challenge.js';

const env = process.env;
const port = Number(env.ZION_WITNESS_PORT ?? 8787);
const host = env.ZION_WITNESS_HOST ?? '127.0.0.1';
const witnessId = env.ZION_WITNESS_ID;
const witnessKeyId = env.ZION_WITNESS_KEY_ID;
const privateKeyPath = env.ZION_WITNESS_PRIVATE_KEY;
const clientTokenPath = env.ZION_WITNESS_CLIENT_TOKEN_FILE;
const tlsCertPath = env.ZION_WITNESS_TLS_CERT;
const tlsKeyPath = env.ZION_WITNESS_TLS_KEY;
const statePath = resolve(env.ZION_WITNESS_STATE ?? '.zion-witness-state.json');
const lockPath = `${statePath}.lock`;
const rateStatePath = `${statePath}.rate-limits.json`;
const rateLockPath = `${rateStatePath}.lock`;
const maxBodyBytes = 16 * 1024;
const maxConsumedNonces = 10_000;
const lockAttempts = 80;
const rateWindowMs = 60_000;
const rateLimit = Number(env.ZION_WITNESS_RATE_LIMIT_PER_MINUTE ?? 60);
const maxRateLimitKeys = 1_000;
if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) throw new Error('TLS requires both ZION_WITNESS_TLS_CERT and ZION_WITNESS_TLS_KEY');
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
if (!loopbackHosts.has(host) && !tlsCertPath) throw new Error('Non-loopback bind requires TLS; configure ZION_WITNESS_TLS_CERT and ZION_WITNESS_TLS_KEY');
if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100_000 || !Number.isInteger(port) || port < 1 || port > 65535 || !witnessId || !witnessKeyId || !privateKeyPath || !clientTokenPath || !env.ZION_WITNESS_STATE) {
  console.error('Required env: ZION_WITNESS_ID, ZION_WITNESS_KEY_ID, ZION_WITNESS_PRIVATE_KEY, ZION_WITNESS_STATE, ZION_WITNESS_CLIENT_TOKEN_FILE; optional ZION_WITNESS_HOST (default 127.0.0.1), ZION_WITNESS_PORT (8787)');
  process.exit(2);
}
function readRegular(path) {
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); if (!fstatSync(fd).isFile()) throw new Error('not a regular file'); return readFileSync(fd); }
  finally { if (fd !== undefined) closeSync(fd); }
}
const privateKey = createPrivateKey(readRegular(resolve(privateKeyPath)));
function loadClientCredentials() {
  const raw = readRegular(resolve(clientTokenPath)).toString('utf8').trim();
  let clients;
  if (raw.startsWith('{')) {
    const document = JSON.parse(raw);
    if (document.schemaVersion !== 1 || !Array.isArray(document.clients)) throw new Error('Invalid client credential document');
    clients = document.clients;
  } else {
    clients = [{ id: 'legacy', token: raw, enabled: true }];
  }
  const seenIds = new Set();
  const seenTokens = new Set();
  for (const client of clients) {
    if (!client || typeof client.id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(client.id) || typeof client.token !== 'string' || Buffer.byteLength(client.token) < 32 || /[\r\n]/.test(client.token) || typeof client.enabled !== 'boolean' || seenIds.has(client.id) || seenTokens.has(client.token)) throw new Error('Invalid or duplicate client credential');
    seenIds.add(client.id); seenTokens.add(client.token);
  }
  return clients;
}
function authenticate(req) {
  const supplied = req.headers.authorization;
  if (typeof supplied !== 'string' || !supplied.startsWith('Bearer ')) return null;
  const actual = Buffer.from(supplied, 'utf8');
  let matched = null;
  // Evaluate every configured credential; do not log or retain supplied tokens.
  for (const client of loadClientCredentials()) {
    const expected = Buffer.from(`Bearer ${client.token}`, 'utf8');
    const equal = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (equal && client.enabled) matched = client.id;
  }
  return matched;
}
function audit(event, fields = {}) {
  // Audit records use a strict allowlist: credentials, headers, request bodies,
  // filesystem paths, and arbitrary exception messages must never enter logs.
  const record = { component: 'remote-witness-auth', event: String(event).slice(0, 64), at: new Date().toISOString() };
  if (typeof fields.clientId === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(fields.clientId)) record.clientId = fields.clientId;
  if (typeof fields.remoteAddress === 'string' && fields.remoteAddress.length <= 128 && /^[a-fA-F0-9:.%_-]+$/.test(fields.remoteAddress)) record.remoteAddress = fields.remoteAddress;
  console.log(JSON.stringify(record));
}
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Witness private key must be Ed25519');
function readState() {
  try {
    const state = JSON.parse(readRegular(statePath).toString('utf8'));
    if (![1, 2].includes(state.schemaVersion) || !Number.isSafeInteger(state.sequence) || state.sequence < 0) throw new Error('Invalid witness sequence state');
    const consumedNonces = state.schemaVersion === 2 ? state.consumedNonces : [];
    if (!Array.isArray(consumedNonces) || consumedNonces.some(x => !x || !/^[a-f0-9]{64}$/.test(x.nonce ?? '') || !Number.isSafeInteger(x.expiresAt))) throw new Error('Invalid witness nonce state');
    return { schemaVersion: 2, sequence: state.sequence, consumedNonces };
  } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 2, sequence: 0, consumedNonces: [] }; throw error; }
}
function persistState(state) {
  const tmp = `${statePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(tmp, statePath);
    const dirFd = openSync(dirname(statePath), fsConstants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}
async function withStateLock(fn) {
  const owner = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(resolve(lockPath, 'owner'), `${owner}\n`, { flag: 'wx', mode: 0o600 });
      acquired = true; break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(25);
    }
  }
  if (!acquired) throw new Error('Witness state lock unavailable; refusing to sign');
  try { return await fn(); }
  finally {
    try {
      const lockOwner = readFileSync(resolve(lockPath, 'owner'), 'utf8').trim();
      if (lockOwner === owner) { unlinkSync(resolve(lockPath, 'owner')); rmdirSync(lockPath); }
    } catch { /* Fail closed on the next request if lock ownership is uncertain. */ }
  }
}
async function withExclusiveDirectoryLock(path, fn) {
  const owner = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(resolve(path, 'owner'), `${owner}\n`, { flag: 'wx', mode: 0o600 });
      acquired = true; break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(25);
    }
  }
  if (!acquired) throw new Error('Shared rate-limit lock unavailable');
  try { return await fn(); }
  finally {
    try {
      const lockOwner = readFileSync(resolve(path, 'owner'), 'utf8').trim();
      if (lockOwner === owner) { unlinkSync(resolve(path, 'owner')); rmdirSync(path); }
    } catch { /* Fail closed on subsequent requests if ownership is uncertain. */ }
  }
}
function readRateState(now) {
  try {
    const parsed = JSON.parse(readRegular(rateStatePath).toString('utf8'));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.windows) || parsed.windows.some(x => !x || typeof x.key !== 'string' || !Number.isSafeInteger(x.count) || x.count < 0 || !Number.isSafeInteger(x.resetAt))) throw new Error('Invalid shared rate-limit state');
    return { schemaVersion: 1, windows: parsed.windows.filter(x => x.resetAt > now) };
  } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, windows: [] }; throw error; }
}
function persistRateState(state) {
  const tmp = `${rateStatePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, rateStatePath);
    const dirFd = openSync(dirname(rateStatePath), fsConstants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}
async function isRateLimited(req, clientId) {
  return withExclusiveDirectoryLock(rateLockPath, async () => {
    const now = Date.now();
    const key = `${req.socket.remoteAddress ?? 'unknown'}\u0000${clientId}`;
    const state = readRateState(now);
    let window = state.windows.find(item => item.key === key);
    if (!window) {
      if (state.windows.length >= maxRateLimitKeys) return true;
      window = { key, count: 0, resetAt: now + rateWindowMs };
      state.windows.push(window);
    }
    const limited = window.count >= rateLimit;
    if (!limited) window.count += 1;
    persistRateState(state);
    return limited;
  });
}
function send(res, status, body) { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); }
const handler = async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/witness/challenge') { send(res, 404, { error: 'not_found' }); return; }
  let clientId;
  try { clientId = authenticate(req); } catch (error) { audit('credential_store_error'); send(res, 503, { error: 'authentication_unavailable' }); console.error(error.message); return; }
  if (!clientId) { audit('authentication_failed', { remoteAddress: req.socket.remoteAddress ?? 'unknown' }); res.setHeader('www-authenticate', 'Bearer'); send(res, 401, { error: 'unauthorized' }); return; }
  audit('authentication_succeeded', { clientId });
  let limited;
  try { limited = await isRateLimited(req, clientId); }
  catch (error) { audit('rate_limit_store_error', { clientId }); console.error(error.message); send(res, 503, { error: 'rate_limit_unavailable' }); return; }
  if (limited) { audit('rate_limit_exceeded', { clientId }); res.setHeader('retry-after', '60'); send(res, 429, { error: 'rate_limit_exceeded' }); return; }
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { send(res, 415, { error: 'content_type_must_be_json' }); return; }
  let size = 0; const chunks = []; let tooLarge = false;
  req.on('data', chunk => { size += chunk.length; if (size > maxBodyBytes) { tooLarge = true; send(res, 413, { error: 'body_too_large' }); req.destroy(); } else chunks.push(chunk); });
  req.on('end', () => {
    if (tooLarge) return;
    let challenge;
    try { challenge = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(res, 400, { error: 'invalid_json' }); return; }
    const now = Date.now();
    if (!challenge || challenge.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(challenge.nonce ?? '') || !/^[a-f0-9]{64}$/.test(challenge.expectedHistoryHeadSha256 ?? '') || !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) || challenge.issuedAt > now || challenge.expiresAt < now || challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > 300000) { send(res, 400, { error: 'invalid_or_expired_challenge' }); return; }
    withStateLock(async () => {
      const state = readState();
      state.consumedNonces = state.consumedNonces.filter(item => item.expiresAt >= Date.now());
      if (state.consumedNonces.some(item => item.nonce === challenge.nonce)) { send(res, 409, { error: 'challenge_replay' }); return; }
      if (state.consumedNonces.length >= maxConsumedNonces) { send(res, 503, { error: 'nonce_capacity_reached' }); return; }
      if (state.sequence >= Number.MAX_SAFE_INTEGER) { send(res, 503, { error: 'sequence_exhausted' }); return; }
      const next = state.sequence + 1;
      state.sequence = next;
      state.consumedNonces.push({ nonce: challenge.nonce, expiresAt: challenge.expiresAt });
      persistState(state);
      const response = createNotificationRecoveryAnchorWitnessChallengeResponse({ challenge, witnessId, witnessKeyId, sequence: next, issuedAt: Date.now(), privateKey });
      send(res, 200, response);
    }).catch(error => { send(res, 503, { error: 'witness_state_unavailable' }); console.error(error.message); });
  });
  req.on('error', () => { if (!res.headersSent) send(res, 400, { error: 'request_error' }); });
};
const server = tlsCertPath
  ? createHttpsServer({ cert: readRegular(resolve(tlsCertPath)), key: readRegular(resolve(tlsKeyPath)) }, handler)
  : createHttpServer(handler);
server.listen(port, host, () => console.log(`Zion remote witness listening on ${host}:${port} (${tlsCertPath ? 'https' : 'http'})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
