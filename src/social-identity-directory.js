import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA = 1;
const USERNAME = /^[a-z0-9_]{3,24}$/;
const MAX_PROOF_AGE_MS = 10 * 60 * 1000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function publicKeyDer(pem, field) {
  if (typeof pem !== 'string' || pem.length > 8192) throw new TypeError(`${field} must be a public key PEM`);
  try { return createPublicKey(pem).export({ type: 'spki', format: 'der' }); }
  catch { throw new TypeError(`${field} is invalid`); }
}
function identityId(signingPublicKeyPem) {
  return `zion:${createHash('sha256').update(publicKeyDer(signingPublicKeyPem, 'signingPublicKeyPem')).digest('hex')}`;
}
function registrationPayload({ username, signingPublicKeyPem, encryptionPublicKeyPem, createdAt }) {
  return { version: SCHEMA, username, signingPublicKeyPem, encryptionPublicKeyPem, createdAt };
}
function validUsername(username) {
  if (typeof username !== 'string' || !USERNAME.test(username)) throw new TypeError('username must be 3-24 lowercase ASCII letters, digits, or underscores');
  return username;
}

/** Create a proof-of-possession profile. This proves key control, not a real-world identity. */
export function createSocialIdentityRegistration({ username, signingPrivateKeyPem, signingPublicKeyPem, encryptionPublicKeyPem, createdAt = Date.now() }) {
  validUsername(username);
  publicKeyDer(signingPublicKeyPem, 'signingPublicKeyPem');
  publicKeyDer(encryptionPublicKeyPem, 'encryptionPublicKeyPem');
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('createdAt must be a non-negative safe integer');
  const payload = registrationPayload({ username, signingPublicKeyPem, encryptionPublicKeyPem, createdAt });
  let proof;
  try { proof = sign(null, Buffer.from(canonical(payload)), createPrivateKey(signingPrivateKeyPem)).toString('base64'); }
  catch { throw new TypeError('signingPrivateKeyPem is invalid'); }
  return Object.freeze({ ...payload, identityId: identityId(signingPublicKeyPem), proof });
}

export function verifySocialIdentityRegistration(registration, { now = Date.now(), maxAgeMs = MAX_PROOF_AGE_MS } = {}) {
  try {
    if (!registration || typeof registration !== 'object' || Array.isArray(registration) || registration.version !== SCHEMA) return false;
    validUsername(registration.username);
    publicKeyDer(registration.signingPublicKeyPem, 'signingPublicKeyPem');
    publicKeyDer(registration.encryptionPublicKeyPem, 'encryptionPublicKeyPem');
    if (registration.identityId !== identityId(registration.signingPublicKeyPem)) return false;
    if (!Number.isSafeInteger(registration.createdAt) || registration.createdAt > now + 30_000 || now - registration.createdAt > maxAgeMs) return false;
    if (typeof registration.proof !== 'string' || registration.proof.length > 8192) return false;
    const payload = registrationPayload(registration);
    return verify(null, Buffer.from(canonical(payload)), createPublicKey(registration.signingPublicKeyPem), Buffer.from(registration.proof, 'base64'));
  } catch { return false; }
}

/**
 * Small persistent profile directory. Identity IDs are fingerprints of signing keys;
 * usernames are unique labels, not proof of a person's real-world identity.
 * This is a local trust directory, not global consensus or a Sybil-resistant registry.
 */
export class SocialIdentityDirectory {
  #records = new Map();
  #usernames = new Map();
  #loaded = false;
  #writeChain = Promise.resolve();

  constructor({ filePath, now = () => Date.now(), maxProfiles = 100_000 } = {}) {
    if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
    if (typeof now !== 'function' || !Number.isSafeInteger(maxProfiles) || maxProfiles < 1) throw new TypeError('invalid directory configuration');
    this.filePath = resolve(filePath);
    this.now = now;
    this.maxProfiles = maxProfiles;
  }

  async init() {
    if (this.#loaded) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.schema !== SCHEMA || !Array.isArray(parsed.profiles)) throw new Error('invalid directory schema');
      if (parsed.profiles.length > this.maxProfiles) throw new Error('directory profile limit exceeded');
      for (const profile of parsed.profiles) {
        if (!profile || profile.identityId !== identityId(profile.signingPublicKeyPem) || !verifyStoredProof(profile)) throw new Error('invalid stored identity profile');
        if (this.#records.has(profile.identityId) || this.#usernames.has(profile.username)) throw new Error('duplicate stored identity profile');
        this.#records.set(profile.identityId, Object.freeze(structuredClone(profile)));
        this.#usernames.set(profile.username, profile.identityId);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Unable to load identity directory: ${error.message}`);
    }
    this.#loaded = true;
    return this;
  }

  async register(registration) {
    await this.init();
    if (!verifySocialIdentityRegistration(registration, { now: this.now() })) throw new TypeError('invalid or expired identity proof');
    return this.#mutate(() => {
      const existing = this.#records.get(registration.identityId);
      if (existing) {
        if (existing.username !== registration.username || existing.encryptionPublicKeyPem !== registration.encryptionPublicKeyPem || existing.signingPublicKeyPem !== registration.signingPublicKeyPem) throw new Error('identity already registered with different profile data');
        return { created: false, profile: publicProfile(existing) };
      }
      if (this.#usernames.has(registration.username)) throw Object.assign(new Error('username already taken'), { code: 'USERNAME_TAKEN' });
      if (this.#records.size >= this.maxProfiles) throw new Error('identity directory capacity reached');
      const record = Object.freeze(structuredClone(registration));
      this.#records.set(record.identityId, record);
      this.#usernames.set(record.username, record.identityId);
      return { created: true, profile: publicProfile(record) };
    });
  }

  async getById(id) { await this.init(); const record = this.#records.get(id); return record ? publicProfile(record) : null; }
  async getByUsername(username) { await this.init(); const id = this.#usernames.get(username); return id ? publicProfile(this.#records.get(id)) : null; }
  async list({ limit = 50, after = '' } = {}) {
    await this.init();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100');
    const profiles = [...this.#records.values()].filter(p => p.identityId > after).sort((a, b) => a.identityId.localeCompare(b.identityId)).slice(0, limit);
    return profiles.map(publicProfile);
  }
  async stats() { await this.init(); return Object.freeze({ profiles: this.#records.size, usernames: this.#usernames.size }); }

  #mutate(operation) {
    const task = this.#writeChain.then(async () => {
      const result = operation();
      await this.#persist();
      return result;
    });
    this.#writeChain = task.catch(() => {});
    return task;
  }
  async #persist() {
    const temp = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify({ schema: SCHEMA, profiles: [...this.#records.values()] }), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.filePath);
  }
}

function verifyStoredProof(profile) {
  try {
    if (!profile || profile.version !== SCHEMA || !USERNAME.test(profile.username) || typeof profile.proof !== 'string') return false;
    const payload = registrationPayload(profile);
    return verify(null, Buffer.from(canonical(payload)), createPublicKey(profile.signingPublicKeyPem), Buffer.from(profile.proof, 'base64'));
  } catch { return false; }
}
function publicProfile(record) {
  return Object.freeze({ identityId: record.identityId, username: record.username, signingPublicKeyPem: record.signingPublicKeyPem, encryptionPublicKeyPem: record.encryptionPublicKeyPem, createdAt: record.createdAt });
}
