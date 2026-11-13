import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  randomBytes, randomUUID,
} from 'node:crypto';

const RECORD_VERSION = 1;
const KEY_PURPOSE = 'zion-node-identity-dek-v1';
const DOMAIN = 'ZION-NODE-IDENTITY-RECORD-V1';
const NODE_ID_RE = /^[a-f0-9]{64}$/;
const KEY_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const MAX_WRAPPED_KEY_BYTES = 4096;
const MAX_CIPHERTEXT_BYTES = 16 * 1024;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new TypeError(`${label} has an invalid schema`);
  }
}

function decodeBase64(value, label, maxBytes) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be canonical base64`);
  // Reject oversized encoded input before Buffer.from allocates its decoded copy.
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
  if (value.length > maxEncodedLength) throw new RangeError(`${label} exceeds its encoded size limit`);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw new RangeError(`${label} has an invalid size or encoding`);
  return bytes;
}

function aadFor(record) {
  return Buffer.from([
    DOMAIN, String(record.schemaVersion), record.algorithm, record.cipher,
    record.keyId, record.nodeId, record.publicKeyDer,
  ].join('\0'));
}

function deriveNodeId(publicKeyDer) {
  return createHash('sha256').update(publicKeyDer).digest('hex');
}

function validateIdentity(identity) {
  if (!identity?.privateKey || identity.privateKey.type !== 'private' ||
      identity.privateKey.asymmetricKeyType !== 'ed25519' ||
      typeof identity.publicKeyPem !== 'string' || !NODE_ID_RE.test(identity.nodeId || '')) {
    throw new TypeError('A valid Ed25519 node identity is required');
  }
  const publicKey = createPublicKey(identity.privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  if (publicKey.export({ type: 'spki', format: 'pem' }).toString() !== identity.publicKeyPem ||
      deriveNodeId(publicDer) !== identity.nodeId) {
    throw new Error('Node identity public key does not match its private key and node ID');
  }
  return publicDer;
}

function requireKeystore(keystore, methods) {
  if (!keystore || typeof keystore !== 'object' ||
      methods.some(method => typeof keystore[method] !== 'function')) {
    throw new TypeError(`Local keystore must implement ${methods.join(', ')}`);
  }
}

/**
 * Encrypt an Ed25519 identity record. The wrapping key never enters this module:
 * only the local keystore adapter may wrap/unwrap the random DEK.
 */
export async function createEncryptedNodeIdentityRecord(identity, keystore, {
  keyId = `zion-node-identity:${randomUUID()}`,
  random = randomBytes,
} = {}) {
  requireKeystore(keystore, ['createOrGetWrappingKey', 'wrapKey']);
  if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) throw new TypeError('Invalid local keystore key ID');
  if (typeof random !== 'function') throw new TypeError('Random source must be a function');
  const publicDer = validateIdentity(identity);
  const record = {
    schemaVersion: RECORD_VERSION,
    algorithm: 'Ed25519',
    cipher: 'AES-256-GCM',
    keyId,
    nodeId: identity.nodeId,
    publicKeyDer: publicDer.toString('base64'),
  };
  let dek;
  let privateDer;
  try {
    await keystore.createOrGetWrappingKey({ keyId, purpose: KEY_PURPOSE });
    dek = Buffer.from(random(32));
    if (dek.length !== 32) throw new Error('Random source must return exactly 32 bytes');
    privateDer = identity.privateKey.export({ type: 'pkcs8', format: 'der' });
    if (privateDer.length < 1 || privateDer.length > MAX_CIPHERTEXT_BYTES) throw new RangeError('Private key encoding has an invalid size');
    const nonce = Buffer.from(random(12));
    if (nonce.length !== 12) throw new Error('Random source must return exactly 12 bytes for the AES-GCM nonce');
    const cipher = createCipheriv('aes-256-gcm', dek, nonce);
    cipher.setAAD(aadFor(record));
    const ciphertext = Buffer.concat([cipher.update(privateDer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrappedValue = await keystore.wrapKey({ keyId, plaintextKey: dek });
    if (!(wrappedValue instanceof Uint8Array)) throw new TypeError('Local keystore must return wrapped key bytes');
    const wrapped = Buffer.from(wrappedValue);
    if (wrapped.length < 1 || wrapped.length > MAX_WRAPPED_KEY_BYTES) throw new RangeError('Wrapped DEK has an invalid size');
    return Object.freeze({
      ...record,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64'),
      wrappedDek: wrapped.toString('base64'),
    });
  } finally {
    dek?.fill(0);
    privateDer?.fill(0);
  }
}

/** Authenticate, decrypt and re-derive the public identity before returning a KeyObject. */
export async function loadEncryptedNodeIdentityRecord(record, keystore) {
  requireKeystore(keystore, ['unwrapKey']);
  exactKeys(record, ['schemaVersion', 'algorithm', 'cipher', 'keyId', 'nodeId', 'publicKeyDer', 'nonce', 'ciphertext', 'authTag', 'wrappedDek'], 'Node identity record');
  if (record.schemaVersion !== RECORD_VERSION || record.algorithm !== 'Ed25519' ||
      record.cipher !== 'AES-256-GCM' || typeof record.keyId !== 'string' || !KEY_ID_RE.test(record.keyId) ||
      !NODE_ID_RE.test(record.nodeId || '')) throw new Error('Unsupported or invalid node identity record');
  const publicDer = decodeBase64(record.publicKeyDer, 'Public key', 1024);
  if (deriveNodeId(publicDer) !== record.nodeId) throw new Error('Stored node ID does not match the public key');
  const nonce = decodeBase64(record.nonce, 'Nonce', 12);
  const ciphertext = decodeBase64(record.ciphertext, 'Ciphertext', MAX_CIPHERTEXT_BYTES);
  const authTag = decodeBase64(record.authTag, 'Authentication tag', 16);
  const wrappedDek = decodeBase64(record.wrappedDek, 'Wrapped DEK', MAX_WRAPPED_KEY_BYTES);
  if (nonce.length !== 12 || authTag.length !== 16 || ciphertext.length < 1 || wrappedDek.length < 1) {
    throw new Error('Node identity record contains invalid cryptographic field lengths');
  }
  let dek;
  let privateDer;
  try {
    const unwrappedValue = await keystore.unwrapKey({ keyId: record.keyId, wrappedKey: wrappedDek });
    if (!(unwrappedValue instanceof Uint8Array)) throw new TypeError('Local keystore must return unwrapped key bytes');
    dek = Buffer.from(unwrappedValue);
    if (dek.length !== 32) throw new Error('Local keystore returned an invalid DEK');
    const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
    decipher.setAAD(aadFor(record));
    decipher.setAuthTag(authTag);
    privateDer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const privateKey = createPrivateKey({ key: privateDer, type: 'pkcs8', format: 'der' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Recovered private key is not Ed25519');
    const publicKey = createPublicKey(privateKey);
    const derivedPublicDer = publicKey.export({ type: 'spki', format: 'der' });
    if (!derivedPublicDer.equals(publicDer) || deriveNodeId(derivedPublicDer) !== record.nodeId) {
      throw new Error('Recovered private key does not match the stored public identity');
    }
    return Object.freeze({
      nodeId: record.nodeId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey,
    });
  } finally {
    dek?.fill(0);
    privateDer?.fill(0);
  }
}
