import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
function assertHash(value, name = 'sha256') {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
}
function signObject(payload, privateKeyPem) {
  return cryptoSign(null, Buffer.from(stableJson(payload)), privateKeyPem).toString('base64');
}
function verifyObject(payload, signature, publicKeyPem) {
  try { return typeof signature === 'string' && cryptoVerify(null, Buffer.from(stableJson(payload)), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64')); }
  catch { return false; }
}

/** Local pre-encryption exact-hash screening. Never transmits the digest or content. This is NOT a ZKP. */
export function screenContentHashLocally(content, { blacklistSha256 = [], maxBytes = 64 * 1024 * 1024 } = {}) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.length > maxBytes) return { accepted: false, reason: 'size-limit', sha256: null };
  const digest = createHash('sha256').update(bytes).digest('hex');
  const blocked = new Set(blacklistSha256);
  for (const item of blocked) assertHash(item, 'blacklist entry');
  return { accepted: !blocked.has(digest), reason: blocked.has(digest) ? 'blacklisted-hash' : 'clear', sha256: digest, bytes: bytes.length, privacy: 'local-only-no-network-disclosure' };
}

export function createUploaderAttributionManifest({ cid, contentSha256, uploaderPublicKeyPem, createdAt = Date.now(), nonce, privateKeyPem }) {
  if (typeof cid !== 'string' || !cid.trim() || cid.length > 512) throw new TypeError('cid must be a non-empty string of at most 512 characters');
  assertHash(contentSha256, 'contentSha256');
  if (typeof uploaderPublicKeyPem !== 'string' || !uploaderPublicKeyPem.includes('PUBLIC KEY')) throw new TypeError('uploaderPublicKeyPem must be a PEM public key');
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('createdAt must be a non-negative integer timestamp');
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) throw new TypeError('nonce must contain 16 to 256 characters');
  const payload = { schemaVersion: 1, cid, contentSha256, uploaderPublicKeyPem, createdAt, nonce };
  return { ...payload, signature: signObject(payload, privateKeyPem) };
}

export function verifyUploaderAttributionManifest(manifest, { expectedCid, now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60_000 } = {}) {
  const fail = (reason) => ({ valid: false, reason });
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.cid !== 'string' || !manifest.cid || manifest.cid.length > 512) return fail('invalid-manifest');
  try { assertHash(manifest.contentSha256, 'contentSha256'); } catch { return fail('invalid-content-hash'); }
  if (expectedCid !== undefined && manifest.cid !== expectedCid) return fail('cid-mismatch');
  if (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt > now + MAX_CLOCK_SKEW_MS || now - manifest.createdAt > maxAgeMs) return fail('manifest-time-invalid-or-stale');
  if (typeof manifest.nonce !== 'string' || manifest.nonce.length < 16 || manifest.nonce.length > 256) return fail('invalid-nonce');
  const { signature, ...payload } = manifest;
  if (!verifyObject(payload, signature, manifest.uploaderPublicKeyPem)) return fail('invalid-uploader-signature');
  return { valid: true, cid: manifest.cid, contentSha256: manifest.contentSha256, uploaderPublicKeyFingerprint: createHash('sha256').update(manifest.uploaderPublicKeyPem).digest('hex'), createdAt: manifest.createdAt };
}

export function createGatewayModerationDecision({ cid, action, caseId, authorityId, issuedAt = Date.now(), expiresAt, privateKeyPem }) {
  if (typeof cid !== 'string' || !cid.trim() || cid.length > 512) throw new TypeError('invalid cid');
  if (!['block', 'unblock'].includes(action)) throw new TypeError('action must be block or unblock');
  if (typeof caseId !== 'string' || !caseId.trim() || caseId.length > 256) throw new TypeError('invalid caseId');
  if (typeof authorityId !== 'string' || !authorityId.trim() || authorityId.length > 256) throw new TypeError('invalid authorityId');
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new TypeError('invalid decision timestamps');
  const payload = { schemaVersion: 1, cid, action, caseId, authorityId, issuedAt, expiresAt };
  return { ...payload, signature: signObject(payload, privateKeyPem) };
}

export function verifyGatewayModerationDecision(decision, { authorityPublicKeyPem, expectedAuthorityId, now = Date.now() } = {}) {
  const fail = (reason) => ({ valid: false, reason });
  if (!decision || decision.schemaVersion !== 1 || !['block', 'unblock'].includes(decision.action) || typeof decision.cid !== 'string' || !decision.cid || typeof decision.caseId !== 'string' || !decision.caseId) return fail('invalid-decision');
  if (decision.authorityId !== expectedAuthorityId) return fail('unexpected-authority');
  if (!Number.isSafeInteger(decision.issuedAt) || !Number.isSafeInteger(decision.expiresAt) || decision.issuedAt > now + MAX_CLOCK_SKEW_MS || decision.expiresAt <= now || decision.expiresAt <= decision.issuedAt) return fail('decision-expired-or-time-invalid');
  const { signature, ...payload } = decision;
  if (!verifyObject(payload, signature, authorityPublicKeyPem)) return fail('invalid-authority-signature');
  return { valid: true, cid: decision.cid, action: decision.action, caseId: decision.caseId, expiresAt: decision.expiresAt };
}

/** In-memory gateway pointer filter. Persistence/replication must be supplied by the host application. */
export class GatewayModerationRegistry {
  #blocked = new Map();
  constructor({ authorityPublicKeyPem, authorityId, now = () => Date.now() }) {
    if (!authorityPublicKeyPem || !authorityId) throw new TypeError('authority key and id are required');
    this.authorityPublicKeyPem = authorityPublicKeyPem; this.authorityId = authorityId; this.now = now;
  }
  apply(decision) {
    const checked = verifyGatewayModerationDecision(decision, { authorityPublicKeyPem: this.authorityPublicKeyPem, expectedAuthorityId: this.authorityId, now: this.now() });
    if (!checked.valid) return checked;
    if (checked.action === 'block') this.#blocked.set(checked.cid, { caseId: checked.caseId, expiresAt: checked.expiresAt });
    else this.#blocked.delete(checked.cid);
    return { valid: true, applied: true, cid: checked.cid, action: checked.action };
  }
  isBlocked(cid) {
    const entry = this.#blocked.get(cid);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) { this.#blocked.delete(cid); return false; }
    return true;
  }
}

/** Small accounting primitive only: no token transfer, chain finality, or automatic punitive action. */
export class UploadStakeLedger {
  #records = new Map();
  #bannedKeys = new Set();
  hold({ uploadId, uploaderKeyFingerprint, amount }) {
    if (typeof uploadId !== 'string' || !uploadId || typeof uploaderKeyFingerprint !== 'string' || !uploaderKeyFingerprint) throw new TypeError('uploadId and uploader fingerprint are required');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('amount must be a positive integer in smallest accounting units');
    if (this.#records.has(uploadId)) throw new Error('duplicate-upload-id');
    if (this.#bannedKeys.has(uploaderKeyFingerprint)) throw new Error('uploader-key-banned');
    this.#records.set(uploadId, { uploadId, uploaderKeyFingerprint, amount, status: 'held', adjudicationId: null });
    return { ...this.#records.get(uploadId) };
  }
  adjudicate({ uploadId, adjudicationId, outcome, authorized }) {
    if (authorized !== true) throw new Error('authorized governance adjudication required');
    if (typeof adjudicationId !== 'string' || !adjudicationId) throw new TypeError('adjudicationId is required');
    if (!['release', 'slash-and-ban'].includes(outcome)) throw new TypeError('invalid outcome');
    const record = this.#records.get(uploadId);
    if (!record) throw new Error('unknown-upload');
    if (record.status !== 'held') throw new Error('stake-already-adjudicated');
    record.status = outcome === 'release' ? 'released' : 'slashed'; record.adjudicationId = adjudicationId;
    if (outcome === 'slash-and-ban') this.#bannedKeys.add(record.uploaderKeyFingerprint);
    return { ...record, banned: this.#bannedKeys.has(record.uploaderKeyFingerprint) };
  }
  get(uploadId) { const value = this.#records.get(uploadId); return value ? { ...value } : null; }
  isBanned(uploaderKeyFingerprint) { return this.#bannedKeys.has(uploaderKeyFingerprint); }
}
