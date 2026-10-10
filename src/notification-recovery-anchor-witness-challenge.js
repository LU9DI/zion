import { randomBytes, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{64}$/;
const challengePayload = challenge => JSON.stringify({ schemaVersion: challenge.schemaVersion, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, expectedHistoryHeadSha256: challenge.expectedHistoryHeadSha256 });
const responsePayload = response => JSON.stringify({ schemaVersion: response.schemaVersion, witnessId: response.witnessId, witnessKeyId: response.witnessKeyId, sequence: response.sequence, nonce: response.nonce, challengeIssuedAt: response.challengeIssuedAt, challengeExpiresAt: response.challengeExpiresAt, issuedAt: response.issuedAt, historyHeadSha256: response.historyHeadSha256 });

/** Create a one-use challenge. The caller must generate a new challenge for every freshness check. */
export function createNotificationRecoveryAnchorWitnessChallenge({ expectedHistoryHeadSha256, now = Date.now(), ttlMs = 30_000 } = {}) {
  if (!HASH.test(expectedHistoryHeadSha256 ?? '') || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000 || !Number.isSafeInteger(now + ttlMs)) throw new TypeError('Invalid witness challenge options');
  const challenge = { schemaVersion: 1, nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + ttlMs, expectedHistoryHeadSha256 };
  return Object.freeze(challenge);
}

/** A remote witness signs its response to the exact challenge and history head. */
export function createNotificationRecoveryAnchorWitnessChallengeResponse({ challenge, witnessId, witnessKeyId, sequence, issuedAt = Date.now(), privateKey } = {}) {
  if (!challenge || challenge.schemaVersion !== 1 || !NONCE.test(challenge.nonce ?? '') || !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt <= challenge.issuedAt || !HASH.test(challenge.expectedHistoryHeadSha256 ?? '') || !ID.test(witnessId ?? '') || !ID.test(witnessKeyId ?? '') || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(issuedAt) || issuedAt < challenge.issuedAt || issuedAt > challenge.expiresAt) throw new TypeError('Invalid witness challenge response fields');
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Witness challenge response key must use Ed25519');
  const response = { schemaVersion: 1, witnessId, witnessKeyId, sequence, nonce: challenge.nonce, challengeIssuedAt: challenge.issuedAt, challengeExpiresAt: challenge.expiresAt, issuedAt, historyHeadSha256: challenge.expectedHistoryHeadSha256 };
  return Object.freeze({ ...response, signature: sign(null, Buffer.from(responsePayload(response)), key).toString('base64') });
}

/** Verify a response against a fresh locally issued nonce; replay resistance requires a new nonce per check. */
export function verifyNotificationRecoveryAnchorWitnessChallengeResponse({ response, publicKey, expectedWitnessId, expectedWitnessKeyId, expectedNonce, expectedHistoryHeadSha256, now = Date.now(), maxResponseAgeMs = 30_000, minimumSequence = 1 } = {}) {
  const invalid = code => ({ valid: false, code });
  if (!response || response.schemaVersion !== 1 || !ID.test(response.witnessId ?? '') || !ID.test(response.witnessKeyId ?? '') || !Number.isSafeInteger(response.sequence) || response.sequence < 1 || !NONCE.test(response.nonce ?? '') || !Number.isSafeInteger(response.challengeIssuedAt) || !Number.isSafeInteger(response.challengeExpiresAt) || !Number.isSafeInteger(response.issuedAt) || !HASH.test(response.historyHeadSha256 ?? '') || typeof response.signature !== 'string') return invalid('challenge-response-malformed');
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxResponseAgeMs) || maxResponseAgeMs < 0 || !Number.isSafeInteger(minimumSequence) || minimumSequence < 1) throw new TypeError('Invalid challenge response verification options');
  if (expectedWitnessId && response.witnessId !== expectedWitnessId) return invalid('challenge-witness-id-mismatch');
  if (expectedWitnessKeyId && response.witnessKeyId !== expectedWitnessKeyId) return invalid('challenge-witness-key-id-mismatch');
  if (expectedNonce && response.nonce !== expectedNonce) return invalid('challenge-nonce-mismatch');
  if (response.sequence < minimumSequence) return invalid('challenge-sequence-rollback');
  if (response.challengeExpiresAt <= response.challengeIssuedAt || response.issuedAt < response.challengeIssuedAt || response.issuedAt > response.challengeExpiresAt) return invalid('challenge-window-invalid');
  if (response.challengeIssuedAt > now || response.challengeExpiresAt < now) return invalid('challenge-expired');
  if (response.issuedAt > now || now - response.issuedAt > maxResponseAgeMs) return invalid('challenge-response-stale');
  if (expectedHistoryHeadSha256 && response.historyHeadSha256 !== expectedHistoryHeadSha256) return invalid('challenge-history-head-mismatch');
  let key;
  try { key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey); } catch { return invalid('challenge-public-key-invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') return invalid('challenge-public-key-invalid');
  let signatureValid = false;
  try { signatureValid = verify(null, Buffer.from(responsePayload(response)), key, Buffer.from(response.signature, 'base64')); } catch {}
  return signatureValid ? { valid: true, code: 'challenge-response-verified', witnessId: response.witnessId, witnessKeyId: response.witnessKeyId, sequence: response.sequence, issuedAt: response.issuedAt, historyHeadSha256: response.historyHeadSha256 } : invalid('challenge-signature-invalid');
}
