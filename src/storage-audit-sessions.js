import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { createStorageChallenge, verifyStorageChallengeResponse } from './storage-challenge.js';

const ID = /^[a-f0-9]{64}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
function nodeIdFromPublicKey(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Storage audit identities must use Ed25519');
  return sha256(key.export({ type:'spki', format:'der' }));
}
function challengePayload(envelope) {
  const c = envelope.challenge;
  return JSON.stringify({ version:envelope.version, auditorNodeId:envelope.auditorNodeId,
    auditorPublicKeyPem:envelope.auditorPublicKeyPem, expiresAt:envelope.expiresAt, challenge:{
      version:c.version, challengeId:c.challengeId, root:c.root, byteLength:c.byteLength,
      leafSize:c.leafSize, leafCount:c.leafCount, indices:c.indices
    } });
}
function responsePayload({ version, peerNodeId, response }) {
  return JSON.stringify({ version, peerNodeId, response });
}
function validId(value) { return typeof value === 'string' && ID.test(value); }

/** Sign an audit challenge so peers can authenticate who requested the proof. */
export function signStorageAuditChallenge({ challenge, auditorIdentity, expiresAt } = {}) {
  if (!challenge || !Number.isSafeInteger(expiresAt) || expiresAt <= 0 || !auditorIdentity?.privateKey || !validId(auditorIdentity.nodeId) ||
      nodeIdFromPublicKey(auditorIdentity.publicKeyPem) !== auditorIdentity.nodeId) {
    throw new TypeError('Invalid auditor identity or challenge');
  }
  const envelope = { version:1, auditorNodeId:auditorIdentity.nodeId,
    auditorPublicKeyPem:auditorIdentity.publicKeyPem, expiresAt, challenge };
  return Object.freeze({ ...envelope, signature:sign(null, Buffer.from(challengePayload(envelope)), auditorIdentity.privateKey).toString('base64') });
}

/** Verify challenge signature and bind the claimed auditor ID to its Ed25519 public key. */
export function verifyStorageAuditChallenge(envelope, { isTrustedAuditor = () => false, now = Date.now() } = {}) {
  if (!envelope || envelope.version !== 1 || !envelope.challenge ||
      !validId(envelope.auditorNodeId) || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= now || typeof envelope.auditorPublicKeyPem !== 'string' ||
      envelope.auditorPublicKeyPem.length > 8192 || typeof envelope.signature !== 'string' ||
      envelope.signature.length > 1024 || typeof isTrustedAuditor !== 'function') return { ok:false, reason:'invalid-envelope' };
  try {
    if (nodeIdFromPublicKey(envelope.auditorPublicKeyPem) !== envelope.auditorNodeId ||
        isTrustedAuditor(envelope.auditorNodeId, envelope.auditorPublicKeyPem) !== true ||
        !verify(null, Buffer.from(challengePayload(envelope)), createPublicKey(envelope.auditorPublicKeyPem), Buffer.from(envelope.signature,'base64'))) {
      return { ok:false, reason:'untrusted-or-invalid-auditor' };
    }
  } catch { return { ok:false, reason:'untrusted-or-invalid-auditor' }; }
  return { ok:true, auditorNodeId:envelope.auditorNodeId, challenge:envelope.challenge };
}

/** Sign the sampled Merkle proof response with the storage provider's peer identity. */
export function signStorageAuditResponse({ response, peerIdentity } = {}) {
  if (!response || !peerIdentity?.privateKey || !validId(peerIdentity.nodeId) ||
      nodeIdFromPublicKey(peerIdentity.publicKeyPem) !== peerIdentity.nodeId) throw new TypeError('Invalid peer identity or response');
  const payload = { version:1, peerNodeId:peerIdentity.nodeId, response };
  return Object.freeze({ ...payload, peerPublicKeyPem:peerIdentity.publicKeyPem,
    signature:sign(null, Buffer.from(responsePayload(payload)), peerIdentity.privateKey).toString('base64') });
}

/**
 * Stateful auditor: limits outstanding work, expires sessions, authenticates responses,
 * validates Merkle samples, and consumes each challenge exactly once. State is in-memory;
 * production deployments must persist/coordinate consumed IDs across restarts or replicas.
 */
export class StorageAuditSessions {
  constructor({ auditorIdentity, now = () => Date.now(), ttlMs = 60_000, maxPending = 10_000,
    isTrustedPeer = () => true } = {}) {
    if (!auditorIdentity?.privateKey || !validId(auditorIdentity.nodeId) ||
        nodeIdFromPublicKey(auditorIdentity.publicKeyPem) !== auditorIdentity.nodeId ||
        typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 24*60*60_000 ||
        !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1_000_000 ||
        typeof isTrustedPeer !== 'function') throw new TypeError('Invalid storage audit session configuration');
    this.auditorIdentity = auditorIdentity;
    this.now = now; this.ttlMs = ttlMs; this.maxPending = maxPending; this.isTrustedPeer = isTrustedPeer;
    this.pending = new Map(); this.consumed = new Map();
  }
  #prune(now) {
    for (const [id, item] of this.pending) if (item.expiresAt <= now) this.pending.delete(id);
    for (const [id, expiresAt] of this.consumed) if (expiresAt <= now) this.consumed.delete(id);
  }
  issue({ commitment, peerNodeId, sampleCount = 3 } = {}) {
    if (!validId(peerNodeId)) throw new TypeError('Invalid target peer ID');
    const now = this.now(); this.#prune(now);
    if (this.pending.size >= this.maxPending) throw Object.assign(new Error('Too many pending storage audits'), { code:'ZION_AUDIT_CAPACITY' });
    const challenge = createStorageChallenge({ commitment, sampleCount });
    if (this.pending.has(challenge.challengeId) || this.consumed.has(challenge.challengeId)) throw new Error('Challenge ID collision');
    const expiresAt = now + this.ttlMs;
    this.pending.set(challenge.challengeId, { challenge, peerNodeId, issuedAt:now, expiresAt });
    return Object.freeze(signStorageAuditChallenge({ challenge, auditorIdentity:this.auditorIdentity, expiresAt }));
  }
  verify({ envelope, signedResponse } = {}) {
    const now = this.now(); this.#prune(now);
    const challenge = envelope?.challenge;
    const id = challenge?.challengeId;
    if (typeof id !== 'string' || !this.pending.has(id)) {
      return { ok:false, reason:this.consumed.has(id) ? 'replay' : 'unknown-or-expired-challenge' };
    }
    const session = this.pending.get(id);
    if (session.expiresAt <= now) { this.pending.delete(id); return { ok:false, reason:'expired-challenge' }; }
    if (!signedResponse || signedResponse.version !== 1 || signedResponse.peerNodeId !== session.peerNodeId ||
        typeof signedResponse.peerPublicKeyPem !== 'string' || signedResponse.peerPublicKeyPem.length > 8192 ||
        typeof signedResponse.signature !== 'string' || signedResponse.signature.length > 1024) return { ok:false, reason:'invalid-peer-envelope' };
    try {
      if (nodeIdFromPublicKey(signedResponse.peerPublicKeyPem) !== session.peerNodeId ||
          this.isTrustedPeer(session.peerNodeId, signedResponse.peerPublicKeyPem) !== true ||
          !verify(null, Buffer.from(responsePayload({version:1,peerNodeId:signedResponse.peerNodeId,response:signedResponse.response})),
            createPublicKey(signedResponse.peerPublicKeyPem), Buffer.from(signedResponse.signature,'base64'))) {
        return { ok:false, reason:'invalid-peer-signature' };
      }
    } catch { return { ok:false, reason:'invalid-peer-signature' }; }
    const result = verifyStorageChallengeResponse({ challenge:session.challenge, response:signedResponse.response });
    if (!result.ok) return { ...result, reason:`invalid-proof:${result.reason}` };
    this.pending.delete(id);
    this.consumed.set(id, now + this.ttlMs);
    return Object.freeze({ ok:true, peerNodeId:session.peerNodeId, challengeId:id, verifiedSamples:result.verifiedSamples,
      issuedAt:session.issuedAt, verifiedAt:now });
  }
  get pendingCount() { return this.pending.size; }
}
