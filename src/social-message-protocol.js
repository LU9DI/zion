import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey,
  sign, verify, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';

const VERSION = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;
const KEY_DER_TYPE = 'spki';

function requiredString(value, field, max = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function unsignedEnvelope(envelope) {
  const { signature: _signature, ...unsigned } = envelope;
  return unsigned;
}

function deriveKey(privateKeyPem, publicKeyPem, salt) {
  const shared = diffieHellman({
    privateKey: createPrivateKey(privateKeyPem),
    publicKey: createPublicKey(publicKeyPem),
  });
  try {
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(salt), Buffer.from('zion-social-message-v1'), 32));
  } finally {
    shared.fill(0);
  }
}

function signPayload(payload, privateKeyPem) {
  return sign(null, Buffer.from(canonical(payload)), createPrivateKey(privateKeyPem)).toString('base64');
}

function verifyPayload(payload, signature, publicKeyPem) {
  try { return verify(null, Buffer.from(canonical(payload)), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64')); }
  catch { return false; }
}

export function generateSocialIdentityKeys() {
  const signing = generateKeyPairSync('ed25519');
  const encryption = generateKeyPairSync('x25519');
  return {
    signingPublicKeyPem: signing.publicKey.export({ type: KEY_DER_TYPE, format: 'pem' }),
    signingPrivateKeyPem: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    encryptionPublicKeyPem: encryption.publicKey.export({ type: KEY_DER_TYPE, format: 'pem' }),
    encryptionPrivateKeyPem: encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** Encrypts a message for one recipient and signs its complete routing envelope. */
export function encryptSocialMessage({
  senderId, recipientId, plaintext, senderSigningPrivateKeyPem,
  senderSigningPublicKeyPem, recipientEncryptionPublicKeyPem, id = randomBytes(16).toString('hex'),
  createdAt = Date.now(),
}) {
  requiredString(senderId, 'senderId');
  requiredString(recipientId, 'recipientId');
  requiredString(id, 'id', 128);
  if (senderId === recipientId) throw new TypeError('senderId and recipientId must differ');
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new TypeError(`plaintext must be a string of at most ${MAX_MESSAGE_BYTES} UTF-8 bytes`);
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('createdAt must be a non-negative safe integer');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPrivatePem = ephemeral.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const ephemeralPublicKeyPem = ephemeral.publicKey.export({ type: KEY_DER_TYPE, format: 'pem' });
  const salt = randomBytes(16).toString('hex');
  const key = deriveKey(ephemeralPrivatePem, recipientEncryptionPublicKeyPem, salt);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${VERSION}:${id}:${senderId}:${recipientId}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope = {
      version: VERSION, id, senderId, recipientId, createdAt, salt,
      senderSigningPublicKeyPem,
      ephemeralPublicKeyPem,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    envelope.signature = signPayload(envelope, senderSigningPrivateKeyPem);
    return Object.freeze(envelope);
  } finally {
    key.fill(0);
  }
}

/** Verifies the signature and envelope dimensions without decrypting message content. */
export function verifySocialEnvelopeSignature(envelope, { trustedSenderSigningPublicKeyPem } = {}) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.version !== VERSION) return false;
    for (const field of ['id', 'senderId', 'recipientId', 'salt', 'senderSigningPublicKeyPem', 'ephemeralPublicKeyPem', 'nonce', 'ciphertext', 'tag', 'signature']) {
      requiredString(envelope[field], `envelope.${field}`, field === 'ciphertext' ? MAX_MESSAGE_BYTES * 2 : 8192);
    }
    if (envelope.senderId === envelope.recipientId || !Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0) return false;
    if (trustedSenderSigningPublicKeyPem && trustedSenderSigningPublicKeyPem !== envelope.senderSigningPublicKeyPem) return false;
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_MESSAGE_BYTES) return false;
    return verifyPayload(unsignedEnvelope(envelope), envelope.signature, envelope.senderSigningPublicKeyPem);
  } catch { return false; }
}

/** Creates a recipient-signed acknowledgement for a bounded set of queue items. */
export function createSocialMessageAcknowledgement({ recipientId, queueIds, recipientSigningPrivateKeyPem, createdAt = Date.now() }) {
  requiredString(recipientId, 'recipientId');
  if (!Array.isArray(queueIds) || queueIds.length < 1 || queueIds.length > 500 || queueIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) {
    throw new TypeError('queueIds must contain 1 to 500 valid queue identifiers');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('createdAt must be a non-negative safe integer');
  const uniqueQueueIds = [...new Set(queueIds)].sort();
  const payload = { version: VERSION, recipientId, queueIds: uniqueQueueIds, createdAt };
  return Object.freeze({ ...payload, signature: signPayload(payload, recipientSigningPrivateKeyPem) });
}

/** Verifies a recipient acknowledgement against a previously trusted profile key. */
export function verifySocialMessageAcknowledgement(ack, { trustedRecipientSigningPublicKeyPem, now = Date.now(), maxAgeMs = 5 * 60 * 1000 } = {}) {
  try {
    if (!ack || typeof ack !== 'object' || Array.isArray(ack) || ack.version !== VERSION) return false;
    if (typeof trustedRecipientSigningPublicKeyPem !== 'string' || !trustedRecipientSigningPublicKeyPem) return false;
    requiredString(ack.recipientId, 'ack.recipientId');
    requiredString(ack.signature, 'ack.signature', 8192);
    if (!Array.isArray(ack.queueIds) || ack.queueIds.length < 1 || ack.queueIds.length > 500 || ack.queueIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) return false;
    if (new Set(ack.queueIds).size !== ack.queueIds.length || [...ack.queueIds].sort().some((id, i) => id !== ack.queueIds[i])) return false;
    if (!Number.isSafeInteger(ack.createdAt) || ack.createdAt > now + 30_000 || now - ack.createdAt > maxAgeMs) return false;
    const { signature, ...payload } = ack;
    return verifyPayload(payload, signature, trustedRecipientSigningPublicKeyPem);
  } catch { return false; }
}

/** Verifies sender signature and decrypts only for the intended recipient. */
export function decryptSocialMessage({
  envelope, recipientId, recipientEncryptionPrivateKeyPem,
  trustedSenderSigningPublicKeyPem,
}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('envelope must be an object');
  if (envelope.version !== VERSION) throw new Error('Unsupported Zion social message version');
  for (const field of ['id', 'senderId', 'recipientId', 'salt', 'senderSigningPublicKeyPem', 'ephemeralPublicKeyPem', 'nonce', 'ciphertext', 'tag', 'signature']) {
    requiredString(envelope[field], `envelope.${field}`, field === 'ciphertext' ? MAX_MESSAGE_BYTES * 2 : 8192);
  }
  if (envelope.recipientId !== recipientId) throw new Error('Message is addressed to a different recipient');
  if (!Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0) throw new Error('Invalid message timestamp');
  if (trustedSenderSigningPublicKeyPem && trustedSenderSigningPublicKeyPem !== envelope.senderSigningPublicKeyPem) {
    throw new Error('Sender signing key does not match the trusted profile key');
  }
  if (!verifyPayload(unsignedEnvelope(envelope), envelope.signature, envelope.senderSigningPublicKeyPem)) {
    throw new Error('Invalid sender signature');
  }
  const key = deriveKey(recipientEncryptionPrivateKeyPem, envelope.ephemeralPublicKeyPem, envelope.salt);
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_MESSAGE_BYTES) throw new Error('Invalid encrypted message dimensions');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(`${VERSION}:${envelope.id}:${envelope.senderId}:${envelope.recipientId}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error.message.includes('Invalid encrypted message dimensions')) throw error;
    throw new Error('Message authentication or decryption failed');
  } finally {
    key.fill(0);
  }
}

/** In-memory replay filter. Persist its state only in a trusted, bounded store. */
export class SocialMessageReplayGuard {
  #seen = new Map();
  constructor({ maxEntries = 10_000, ttlMs = 7 * 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive safe integer');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('ttlMs must be a positive safe integer');
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
  }
  accept(envelope) {
    requiredString(envelope?.id, 'envelope.id', 128);
    requiredString(envelope?.senderId, 'envelope.senderId');
    const now = this.now();
    for (const [key, timestamp] of this.#seen) if (now - timestamp >= this.ttlMs) this.#seen.delete(key);
    const key = `${envelope.senderId}:${envelope.id}`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now);
    while (this.#seen.size > this.maxEntries) this.#seen.delete(this.#seen.keys().next().value);
    return true;
  }
  get size() { return this.#seen.size; }
}
