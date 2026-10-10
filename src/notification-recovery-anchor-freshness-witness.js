import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const payload = witness => JSON.stringify({ schemaVersion: witness.schemaVersion, witnessId: witness.witnessId, sequence: witness.sequence, issuedAt: witness.issuedAt, historyHeadSha256: witness.historyHeadSha256, witnessKeyId: witness.witnessKeyId });

export function notificationRecoveryAnchorFreshnessWitnessSha256(witness) {
  if (!witness || typeof witness.signature !== 'string') throw new TypeError('Malformed freshness witness');
  return sha256(JSON.stringify({ ...JSON.parse(payload(witness)), signature: witness.signature }));
}

/** Create a signed freshness statement. The signing key must belong to an independently trusted witness. */
export function createNotificationRecoveryAnchorFreshnessWitness({ witnessId, sequence, issuedAt = Date.now(), historyHeadSha256, witnessKeyId, privateKey } = {}) {
  if (!ID.test(witnessId ?? '') || !ID.test(witnessKeyId ?? '') || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || !HASH.test(historyHeadSha256 ?? '')) throw new TypeError('Invalid freshness witness fields');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Freshness witness key must use Ed25519');
  const witness = { schemaVersion: 1, witnessId, sequence, issuedAt, historyHeadSha256, witnessKeyId };
  return Object.freeze({ ...witness, signature: sign(null, Buffer.from(payload(witness)), key).toString('base64') });
}

/** Verify independent freshness evidence and bind it to the exact head of the supplied history. */
export function verifyNotificationRecoveryAnchorFreshnessWitness({ witness, publicKey, expectedWitnessKeyId, expectedHistoryHeadSha256, now = Date.now(), maxAgeMs = 300_000, minimumSequence = 1 } = {}) {
  const invalid = code => ({ valid: false, code });
  if (!witness || witness.schemaVersion !== 1 || !ID.test(witness.witnessId ?? '') || !ID.test(witness.witnessKeyId ?? '') || !Number.isSafeInteger(witness.sequence) || witness.sequence < 1 || !Number.isSafeInteger(witness.issuedAt) || !HASH.test(witness.historyHeadSha256 ?? '') || typeof witness.signature !== 'string') return invalid('witness-malformed');
  if (!Number.isSafeInteger(now) || now < 0 || !(maxAgeMs === Infinity || (Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0)) || !Number.isSafeInteger(minimumSequence) || minimumSequence < 1) throw new TypeError('Invalid freshness verification options');
  if (expectedWitnessKeyId && witness.witnessKeyId !== expectedWitnessKeyId) return invalid('witness-key-id-mismatch');
  if (witness.sequence < minimumSequence) return invalid('witness-sequence-rollback');
  if (witness.issuedAt > now) return invalid('witness-issued-in-future');
  if (now - witness.issuedAt > maxAgeMs) return invalid('witness-stale');
  if (expectedHistoryHeadSha256 && witness.historyHeadSha256 !== expectedHistoryHeadSha256) return invalid('witness-history-head-mismatch');
  let key;
  try { key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey); } catch { return invalid('witness-public-key-invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') return invalid('witness-public-key-invalid');
  let valid = false;
  try { valid = verify(null, Buffer.from(payload(witness)), key, Buffer.from(witness.signature, 'base64')); } catch {}
  return valid ? { valid: true, code: 'verified', witnessId: witness.witnessId, witnessKeyId: witness.witnessKeyId, sequence: witness.sequence, issuedAt: witness.issuedAt, historyHeadSha256: witness.historyHeadSha256, witnessSha256: notificationRecoveryAnchorFreshnessWitnessSha256(witness) } : invalid('witness-signature-invalid');
}
