import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const payload = e => JSON.stringify({ schemaVersion: e.schemaVersion, action: e.action, eventId: e.eventId, revokedSignerKeyId: e.revokedSignerKeyId, reasonCode: e.reasonCode, issuedAt: e.issuedAt, previousEventSha256: e.previousEventSha256 ?? null });

export function notificationRecoveryAnchorRevocationSha256(event) {
  if (!event || typeof event.signature !== 'string') throw new TypeError('Malformed revocation event');
  return sha256(JSON.stringify({ ...JSON.parse(payload(event)), signature: event.signature }));
}

/** Create a signed revocation event. The signing key must be an independently trusted revocation authority. */
export function createNotificationRecoveryAnchorKeyRevocation({ eventId, revokedSignerKeyId, reasonCode, issuedAt = Date.now(), previousEvent, authorityPrivateKey } = {}) {
  if (!ID.test(eventId ?? '') || !ID.test(revokedSignerKeyId ?? '') || !/^[A-Z][A-Z0-9_]{1,63}$/.test(reasonCode ?? '')) throw new TypeError('Invalid revocation identifiers or reason code');
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('Invalid issuedAt');
  const key = authorityPrivateKey?.type === 'private' ? authorityPrivateKey : createPrivateKey(authorityPrivateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Revocation authority must use Ed25519');
  const event = { schemaVersion: 1, action: 'revoke', eventId, revokedSignerKeyId, reasonCode, issuedAt, previousEventSha256: previousEvent ? notificationRecoveryAnchorRevocationSha256(previousEvent) : null };
  return Object.freeze({ ...event, signature: sign(null, Buffer.from(payload(event)), key).toString('base64') });
}

/** Verify append-only revocation evidence against an out-of-band authority key. */
export function verifyNotificationRecoveryAnchorKeyRevocations({ events = [], authorityPublicKey, now = Date.now(), maxAgeMs = Infinity } = {}) {
  let key;
  try { key = authorityPublicKey?.type === 'public' ? authorityPublicKey : createPublicKey(authorityPublicKey); } catch { return { valid: false, code: 'revocation-authority-invalid', verifiedCount: 0, revokedSignerKeyIds: [] }; }
  if (key.asymmetricKeyType !== 'ed25519') return { valid: false, code: 'revocation-authority-invalid', verifiedCount: 0, revokedSignerKeyIds: [] };
  if (!Array.isArray(events) || !Number.isSafeInteger(now) || now < 0 || !(maxAgeMs === Infinity || (Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0))) throw new TypeError('Invalid revocation verification options');
  const seen = new Set(); const revoked = new Set(); let previousHash = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e || e.schemaVersion !== 1 || e.action !== 'revoke' || !ID.test(e.eventId ?? '') || !ID.test(e.revokedSignerKeyId ?? '') || !/^[A-Z][A-Z0-9_]{1,63}$/.test(e.reasonCode ?? '') || !Number.isSafeInteger(e.issuedAt) || typeof e.signature !== 'string') return { valid: false, code: 'revocation-event-malformed', index: i, verifiedCount: i, revokedSignerKeyIds: [...revoked] };
    if (seen.has(e.eventId)) return { valid: false, code: 'revocation-event-id-reused', index: i, verifiedCount: i, revokedSignerKeyIds: [...revoked] };
    if ((e.previousEventSha256 ?? null) !== previousHash) return { valid: false, code: 'revocation-chain-break', index: i, verifiedCount: i, revokedSignerKeyIds: [...revoked] };
    if (e.issuedAt > now || now - e.issuedAt > maxAgeMs) return { valid: false, code: e.issuedAt > now ? 'revocation-issued-in-future' : 'revocation-too-old', index: i, verifiedCount: i, revokedSignerKeyIds: [...revoked] };
    let ok = false; try { ok = verify(null, Buffer.from(payload(e)), key, Buffer.from(e.signature, 'base64')); } catch {}
    if (!ok) return { valid: false, code: 'revocation-signature-invalid', index: i, verifiedCount: i, revokedSignerKeyIds: [...revoked] };
    seen.add(e.eventId); revoked.add(e.revokedSignerKeyId); previousHash = notificationRecoveryAnchorRevocationSha256(e);
  }
  return { valid: true, code: 'verified', verifiedCount: events.length, revokedSignerKeyIds: [...revoked], lastEventSha256: previousHash };
}
