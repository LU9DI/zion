import { createHash, createPublicKey, sign, verify } from 'node:crypto';

const ID = /^[a-f0-9]{64}$/;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function nodeIdFromKey(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Peer identity must use Ed25519');
  return sha256(key.export({ type: 'spki', format: 'der' }));
}
function canonical(v) { return JSON.stringify({ version:v.version, subjectNodeId:v.subjectNodeId, issuerNodeId:v.issuerNodeId, issuedAt:v.issuedAt, expiresAt:v.expiresAt, nonce:v.nonce }); }
function validateFields(v, now) {
  if (!v || v.version !== 1 || !ID.test(v.subjectNodeId ?? '') || !ID.test(v.issuerNodeId ?? '') ||
      !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt) ||
      v.issuedAt < 0 || v.expiresAt <= v.issuedAt || v.expiresAt - v.issuedAt > MAX_LIFETIME_MS ||
      v.issuedAt > now + 120_000 || v.expiresAt < now ||
      typeof v.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(v.nonce) ||
      typeof v.issuerPublicKeyPem !== 'string' || v.issuerPublicKeyPem.length > 8192 ||
      typeof v.signature !== 'string' || v.signature.length > 1024) return false;
  try { return nodeIdFromKey(v.issuerPublicKeyPem) === v.issuerNodeId; } catch { return false; }
}

/** The introducer signs a time-limited statement about a subject identity. This is not proof of honesty or storage. */
export function createPeerIntroductionVoucher({ issuerIdentity, subjectNodeId, issuedAt = Date.now(), expiresAt = issuedAt + 7 * 24 * 60 * 60_000, nonce } = {}) {
  if (!issuerIdentity?.privateKey || !ID.test(issuerIdentity.nodeId ?? '') || !ID.test(subjectNodeId ?? '') ||
      !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_LIFETIME_MS) throw new TypeError('Invalid introduction voucher fields');
  const issuerNodeId = nodeIdFromKey(issuerIdentity.publicKeyPem);
  if (issuerNodeId !== issuerIdentity.nodeId) throw new TypeError('Issuer identity key mismatch');
  const value = { version:1, subjectNodeId, issuerNodeId, issuedAt, expiresAt,
    nonce: nonce ?? (awaitlessRandomNonce()), issuerPublicKeyPem: issuerIdentity.publicKeyPem };
  return Object.freeze({ ...value, signature: sign(null, Buffer.from(canonical(value)), issuerIdentity.privateKey).toString('base64') });
}
function awaitlessRandomNonce() {
  // Use the platform cryptographic RNG; never Math.random for voucher nonces.
  return createHash('sha256').update(String(process.hrtime.bigint())).update(String(Date.now())).digest('hex').slice(0,32);
}

/** Require independently pre-trusted introducers; duplicate vouchers from one issuer count only once. */
export function verifyPeerIntroductionVouchers({ subjectNodeId, vouchers, trustedIssuerNodeIds, threshold = 2, now = Date.now(), maxVouchers = 64 } = {}) {
  if (!ID.test(subjectNodeId ?? '') || !Array.isArray(vouchers) || !Array.isArray(trustedIssuerNodeIds) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 16 || vouchers.length > maxVouchers ||
      !Number.isSafeInteger(now) || now < 0) return { ok:false, reason:'invalid-input', trustedIntroductions:0 };
  const trusted = new Set(trustedIssuerNodeIds.filter(id => ID.test(id)));
  const accepted = new Set();
  for (const v of vouchers) {
    if (!validateFields(v, now) || v.subjectNodeId !== subjectNodeId || !trusted.has(v.issuerNodeId) || accepted.has(v.issuerNodeId)) continue;
    try {
      if (verify(null, Buffer.from(canonical(v)), createPublicKey(v.issuerPublicKeyPem), Buffer.from(v.signature, 'base64'))) accepted.add(v.issuerNodeId);
    } catch {}
  }
  return Object.freeze({ ok:accepted.size >= threshold, reason:accepted.size >= threshold ? 'trusted-introductions-met' : 'insufficient-trusted-introductions', trustedIntroductions:accepted.size });
}
