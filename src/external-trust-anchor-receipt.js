import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const payloadOf = receipt => JSON.stringify({
  schemaVersion: receipt.schemaVersion,
  authorityId: receipt.authorityId,
  sequence: receipt.sequence,
  revision: receipt.revision,
  checkpointSha256: receipt.checkpointSha256,
  issuedAt: receipt.issuedAt,
  expiresAt: receipt.expiresAt,
});

/** Create a signed external trust receipt. Keep the private key on the independent authority. */
export function createExternalTrustAnchorReceipt({ authorityId, sequence, revision, checkpointSha256, issuedAt = Date.now(), ttlMs = 60_000, privateKey } = {}) {
  if (!ID.test(authorityId ?? '') || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(revision) || revision < 0 || !HASH.test(checkpointSha256 ?? '') || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000 || !Number.isSafeInteger(issuedAt + ttlMs)) throw new TypeError('Invalid external trust receipt fields');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('External trust authority key must use Ed25519');
  const body = { schemaVersion: 1, authorityId, sequence, revision, checkpointSha256, issuedAt, expiresAt: issuedAt + ttlMs };
  return Object.freeze({ ...body, signature: sign(null, Buffer.from(payloadOf(body)), key).toString('base64') });
}

/** Verify external authorization and time bounds. Sequence rollback protection requires a separately protected minimumSequence pin. */
export function verifyExternalTrustAnchorReceipt({ receipt, publicKey, expectedAuthorityId, expectedRevision, expectedCheckpointSha256, minimumSequence = 1, now = Date.now(), maxAgeMs = 60_000 } = {}) {
  const invalid = code => ({ valid: false, code, mode: 'external-signed-trust-receipt' });
  if (!receipt || receipt.schemaVersion !== 1 || !ID.test(receipt.authorityId ?? '') || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 || !Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !HASH.test(receipt.checkpointSha256 ?? '') || !Number.isSafeInteger(receipt.issuedAt) || !Number.isSafeInteger(receipt.expiresAt) || typeof receipt.signature !== 'string' || receipt.signature.length > 1024) return invalid('receipt-malformed');
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || !Number.isSafeInteger(minimumSequence) || minimumSequence < 1) throw new TypeError('Invalid receipt verification options');
  if (expectedAuthorityId && receipt.authorityId !== expectedAuthorityId) return invalid('authority-id-mismatch');
  if (expectedRevision !== undefined && receipt.revision !== expectedRevision) return invalid('revision-mismatch');
  if (expectedCheckpointSha256 && receipt.checkpointSha256 !== expectedCheckpointSha256) return invalid('checkpoint-hash-mismatch');
  if (receipt.sequence < minimumSequence) return invalid('external-sequence-rollback');
  if (receipt.expiresAt <= receipt.issuedAt || receipt.issuedAt > now || receipt.expiresAt < now || now - receipt.issuedAt > maxAgeMs) return invalid('receipt-stale-or-outside-validity-window');
  let key;
  try { key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey); } catch { return invalid('authority-public-key-invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') return invalid('authority-public-key-invalid');
  let valid = false;
  try { valid = verify(null, Buffer.from(payloadOf(receipt)), key, Buffer.from(receipt.signature, 'base64')); } catch {}
  if (!valid) return invalid('receipt-signature-invalid');
  return { valid: true, code: 'external-trust-receipt-verified', mode: 'external-signed-trust-receipt', authorityId: receipt.authorityId, sequence: receipt.sequence, revision: receipt.revision, checkpointSha256: receipt.checkpointSha256, issuedAt: receipt.issuedAt, expiresAt: receipt.expiresAt, currentFreshnessProven: true, warning: 'Freshness is bounded by the local clock and the configured maxAgeMs; protect minimumSequence independently to detect replay across restarts.' };
}
