import {
  createHash, createPublicKey, randomBytes, sign, verify,
} from 'node:crypto';

const VERSION = 1;
const DEFAULT_CHALLENGE_TTL_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(token) { return createHash('sha256').update(token).digest('hex'); }

/** Client helper: signs the exact challenge fields returned by the authority. */
export function createSocialAuthenticationProof(challenge, signingPrivateKeyPem) {
  if (!challenge || challenge.version !== VERSION || typeof challenge.challengeId !== 'string' || typeof challenge.nonce !== 'string' || typeof challenge.identityId !== 'string' || !Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt)) throw new TypeError('invalid authentication challenge');
  const payload = { version: VERSION, challengeId: challenge.challengeId, nonce: challenge.nonce, identityId: challenge.identityId, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt };
  return Object.freeze({ ...payload, signature: sign(null, Buffer.from(canonical(payload)), signingPrivateKeyPem).toString('base64') });
}

/**
 * In-memory one-time challenge and identity-bound session authority.
 * Sessions intentionally expire on process restart; persist neither raw tokens nor private keys.
 */
export class SocialSessionAuthority {
  #challenges = new Map();
  #sessions = new Map();

  constructor({ identityDirectory, now = () => Date.now(), challengeTtlMs = DEFAULT_CHALLENGE_TTL_MS,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS, maxPendingChallenges = 10_000, maxSessions = 100_000 } = {}) {
    if (!identityDirectory || typeof identityDirectory.getById !== 'function') throw new TypeError('identityDirectory.getById is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    if (!Number.isSafeInteger(challengeTtlMs) || challengeTtlMs < 5_000 || challengeTtlMs > 5 * 60_000) throw new RangeError('challengeTtlMs must be 5000..300000');
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000 || sessionTtlMs > 24 * 60 * 60_000) throw new RangeError('sessionTtlMs must be 60000..86400000');
    if (!Number.isSafeInteger(maxPendingChallenges) || maxPendingChallenges < 1 || !Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new RangeError('invalid capacity limits');
    this.identityDirectory = identityDirectory; this.now = now; this.challengeTtlMs = challengeTtlMs;
    this.sessionTtlMs = sessionTtlMs; this.maxPendingChallenges = maxPendingChallenges; this.maxSessions = maxSessions;
  }

  async issueChallenge(identityId) {
    this.#prune();
    const profile = await this.identityDirectory.getById(identityId);
    if (!profile) throw Object.assign(new Error('identity_not_found'), { code: 'IDENTITY_NOT_FOUND' });
    if (this.#challenges.size >= this.maxPendingChallenges) throw Object.assign(new Error('challenge_capacity_reached'), { code: 'CAPACITY' });
    for (const [id, item] of this.#challenges) if (item.identityId === identityId) this.#challenges.delete(id);
    const issuedAt = this.now();
    const challenge = Object.freeze({ version: VERSION, challengeId: randomBytes(16).toString('hex'), nonce: randomBytes(32).toString('base64url'), identityId, issuedAt, expiresAt: issuedAt + this.challengeTtlMs });
    this.#challenges.set(challenge.challengeId, challenge);
    return challenge;
  }

  async createSession(proof) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof proof.challengeId !== 'string') throw new TypeError('invalid authentication proof');
    const challenge = this.#challenges.get(proof.challengeId);
    // Consume before verification: every proof attempt is one-shot, including invalid attempts.
    this.#challenges.delete(proof.challengeId);
    const now = this.now();
    if (!challenge || challenge.expiresAt <= now || proof.version !== VERSION || proof.identityId !== challenge.identityId || proof.nonce !== challenge.nonce || proof.issuedAt !== challenge.issuedAt || proof.expiresAt !== challenge.expiresAt || typeof proof.signature !== 'string' || proof.signature.length > 8192) throw Object.assign(new Error('invalid_or_expired_challenge'), { code: 'INVALID_PROOF' });
    const profile = await this.identityDirectory.getById(challenge.identityId);
    if (!profile) throw Object.assign(new Error('identity_not_found'), { code: 'IDENTITY_NOT_FOUND' });
    const { signature, ...payload } = proof;
    let valid = false;
    try { valid = verify(null, Buffer.from(canonical(payload)), createPublicKey(profile.signingPublicKeyPem), Buffer.from(signature, 'base64')); } catch { valid = false; }
    if (!valid) throw Object.assign(new Error('invalid_or_expired_challenge'), { code: 'INVALID_PROOF' });
    this.#prune();
    if (this.#sessions.size >= this.maxSessions) throw Object.assign(new Error('session_capacity_reached'), { code: 'CAPACITY' });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + this.sessionTtlMs;
    this.#sessions.set(digest(token), { identityId: challenge.identityId, expiresAt });
    return Object.freeze({ token, tokenType: 'Bearer', identityId: challenge.identityId, expiresAt });
  }

  authenticateToken(token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 256) return null;
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.now()) { this.#sessions.delete(key); return null; }
    // Hash lookup avoids retaining the bearer token itself in memory.
    return Object.freeze({ identityId: session.identityId, expiresAt: session.expiresAt });
  }

  revokeToken(token) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 256) return false;
    return this.#sessions.delete(digest(token));
  }

  stats() { this.#prune(); return Object.freeze({ pendingChallenges: this.#challenges.size, activeSessions: this.#sessions.size }); }
  #prune() {
    const now = this.now();
    for (const [id, challenge] of this.#challenges) if (challenge.expiresAt <= now) this.#challenges.delete(id);
    for (const [hash, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(hash);
  }
}
