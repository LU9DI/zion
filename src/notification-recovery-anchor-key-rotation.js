import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const payloadOf = value => JSON.stringify({
  schemaVersion: value.schemaVersion,
  action: value.action,
  previousSignerKeyId: value.previousSignerKeyId,
  signerKeyId: value.signerKeyId,
  publicKeyPem: value.publicKeyPem,
  publicKeySha256: value.publicKeySha256,
  issuedAt: value.issuedAt,
  previousTransitionSha256: value.previousTransitionSha256 ?? null,
});

function publicDetails(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Rotation requires Ed25519 keys');
  return {
    key,
    pem: key.export({ type: 'spki', format: 'pem' }),
    fingerprint: sha256(key.export({ type: 'spki', format: 'der' })),
  };
}

export function createNotificationRecoveryAnchorKeyTransition({
  previousSignerKeyId, signerKeyId, publicKey, previousPrivateKey, issuedAt = Date.now(), previousTransition,
} = {}) {
  if (!ID.test(previousSignerKeyId ?? '') || !ID.test(signerKeyId ?? '') || previousSignerKeyId === signerKeyId) throw new TypeError('Invalid or repeated signer key IDs');
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('Invalid issuedAt');
  const next = publicDetails(publicKey);
  const privateKey = previousPrivateKey?.type === 'private' ? previousPrivateKey : createPrivateKey(previousPrivateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Previous signing key must be Ed25519');
  const transition = {
    schemaVersion: 1,
    action: 'rotate',
    previousSignerKeyId,
    signerKeyId,
    publicKeyPem: next.pem,
    publicKeySha256: next.fingerprint,
    issuedAt,
    previousTransitionSha256: previousTransition ? notificationRecoveryAnchorKeyTransitionSha256(previousTransition) : null,
  };
  return Object.freeze({ ...transition, signature: sign(null, Buffer.from(payloadOf(transition)), privateKey).toString('base64') });
}

export function notificationRecoveryAnchorKeyTransitionSha256(transition) {
  if (!transition || typeof transition.signature !== 'string') throw new TypeError('Malformed transition');
  return sha256(JSON.stringify({ ...JSON.parse(payloadOf(transition)), signature: transition.signature }));
}

/** Verify a complete rotation chain against an out-of-band trusted initial policy. */
export function verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy, transitions = [], now = Date.now(), maxAgeMs = Infinity } = {}) {
  if (!trustPolicy || trustPolicy.schemaVersion !== 1 || typeof trustPolicy.signerKeyId !== 'string' || typeof trustPolicy.publicKeyPem !== 'string' || typeof trustPolicy.publicKeySha256 !== 'string') {
    return { valid: false, code: 'initial-trust-policy-invalid', verifiedCount: 0 };
  }
  let current;
  try { current = publicDetails(trustPolicy.publicKeyPem); } catch { return { valid: false, code: 'initial-trust-key-invalid', verifiedCount: 0 }; }
  if (current.fingerprint !== trustPolicy.publicKeySha256 || !ID.test(trustPolicy.signerKeyId)) return { valid: false, code: 'initial-trust-fingerprint-mismatch', verifiedCount: 0 };
  if (!Array.isArray(transitions) || !Number.isSafeInteger(now) || now < 0 || !(maxAgeMs === Infinity || (Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0))) throw new TypeError('Invalid transition verification options');
  let currentId = trustPolicy.signerKeyId;
  let previousHash = null;
  const seen = new Set([currentId]);
  for (let index = 0; index < transitions.length; index++) {
    const t = transitions[index];
    if (!t || t.schemaVersion !== 1 || t.action !== 'rotate' || !ID.test(t.previousSignerKeyId ?? '') || !ID.test(t.signerKeyId ?? '') || !Number.isSafeInteger(t.issuedAt) || typeof t.signature !== 'string' || !HASH.test(t.publicKeySha256 ?? '')) return { valid: false, code: 'transition-malformed', index, verifiedCount: index };
    if (t.previousSignerKeyId !== currentId) return { valid: false, code: 'transition-previous-key-mismatch', index, verifiedCount: index };
    if (t.previousTransitionSha256 !== previousHash) return { valid: false, code: 'transition-chain-break', index, verifiedCount: index };
    if (t.issuedAt > now || now - t.issuedAt > maxAgeMs) return { valid: false, code: t.issuedAt > now ? 'transition-issued-in-future' : 'transition-too-old', index, verifiedCount: index };
    if (seen.has(t.signerKeyId)) return { valid: false, code: 'transition-key-id-reused', index, verifiedCount: index };
    let next;
    try { next = publicDetails(t.publicKeyPem); } catch { return { valid: false, code: 'transition-public-key-invalid', index, verifiedCount: index }; }
    if (next.fingerprint !== t.publicKeySha256) return { valid: false, code: 'transition-fingerprint-mismatch', index, verifiedCount: index };
    let signatureValid = false;
    try { signatureValid = verify(null, Buffer.from(payloadOf(t)), current.key, Buffer.from(t.signature, 'base64')); } catch {}
    if (!signatureValid) return { valid: false, code: 'transition-signature-invalid', index, verifiedCount: index };
    previousHash = notificationRecoveryAnchorKeyTransitionSha256(t);
    current = next;
    currentId = t.signerKeyId;
    seen.add(currentId);
  }
  return { valid: true, code: 'verified', verifiedCount: transitions.length, activeSignerKeyId: currentId, activePublicKey: current.key, activePublicKeySha256: current.fingerprint, lastTransitionSha256: previousHash };
}
