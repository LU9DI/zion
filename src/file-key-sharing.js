import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';
import { signPeerMessage, verifyPeerMessage } from './peer-security.js';

const PROTOCOL = 'zion-file-key-envelope-v1';
const CID = /^[a-f0-9]{64}$/;
const KEY_BYTES = 32;
const ENVELOPE_FIELDS = ['type', 'protocol', 'cid', 'recipientKeyId', 'ephemeralPublicKeyPem', 'salt', 'nonce', 'ciphertext', 'tag'];
const MESSAGE_FIELDS = ['version', 'nodeId', 'timestamp', 'nonce', 'payload', 'publicKeyPem', 'signature'];

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function publicKeyId(key) { return sha256(key.export({ type: 'spki', format: 'der' })); }
function parsePublicKey(pem) {
  if (typeof pem !== 'string' || pem.length > 8192) throw new TypeError('Invalid X25519 public key');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'x25519') throw new TypeError('Recipient key must use X25519');
  return key;
}
function parsePrivateKey(pem) {
  if (typeof pem !== 'string' || pem.length > 16384) throw new TypeError('Invalid X25519 private key');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'x25519') throw new TypeError('Recipient private key must use X25519');
  return key;
}
function decodeBase64(value, expectedLength, label) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error(`Invalid ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    bytes.fill(0);
    throw new Error(`Invalid ${label}`);
  }
  return bytes;
}
function aad({ cid, recipientKeyId, senderNodeId }) {
  return Buffer.from(JSON.stringify({ protocol: PROTOCOL, cid, recipientKeyId, senderNodeId }));
}

/** Generate an X25519 key pair for a recipient device. Protect the private key separately. */
export function generateFileKeyRecipientIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return Object.freeze({
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
}

/**
 * Encrypt a 32-byte file key to one recipient device. The signed envelope binds the recipient,
 * CID, ephemeral key and ciphertext to the sender's Ed25519 node identity.
 */
export function createFileKeyEnvelope(senderIdentity, recipientPublicKeyPem, { cid, fileKey, now = Date.now() } = {}) {
  if (!senderIdentity?.privateKey || !/^[a-f0-9]{64}$/.test(senderIdentity.nodeId ?? '')) throw new TypeError('Invalid sender identity');
  if (!CID.test(cid ?? '')) throw new TypeError('Invalid content identifier');
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid envelope timestamp');
  const recipientPublicKey = parsePublicKey(recipientPublicKeyPem);
  const recipientKeyId = publicKeyId(recipientPublicKey);
  const key = Buffer.isBuffer(fileKey) ? Buffer.from(fileKey) : decodeBase64(fileKey, KEY_BYTES, 'file key');
  if (key.length !== KEY_BYTES) { key.fill(0); throw new TypeError('File key must be exactly 32 bytes'); }

  const { publicKey: ephemeralPublicKey, privateKey: ephemeralPrivateKey } = generateKeyPairSync('x25519');
  const ephemeralPublicKeyPem = ephemeralPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  let sharedSecret;
  let wrappingKey;
  try {
    sharedSecret = diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: recipientPublicKey });
    const salt = randomBytes(32);
    wrappingKey = Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from(PROTOCOL), KEY_BYTES));
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
    cipher.setAAD(aad({ cid, recipientKeyId, senderNodeId: senderIdentity.nodeId }));
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    const payload = {
      type: 'FILE_KEY_ENVELOPE',
      protocol: PROTOCOL,
      cid,
      recipientKeyId,
      ephemeralPublicKeyPem,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    salt.fill(0);
    return signPeerMessage(senderIdentity, payload, { now });
  } finally {
    key.fill(0);
    sharedSecret?.fill(0);
    wrappingKey?.fill(0);
  }
}

/**
 * Verify and decrypt a historical key envelope. Pass expectedSenderNodeId from an independently
 * trusted directory when sender authorization matters; signature validity alone is not trust.
 * The caller owns the returned 32-byte key and should zero it when finished.
 */
export function openFileKeyEnvelope(message, recipientPrivateKeyPem, {
  expectedCid, expectedSenderNodeId,
} = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message) ||
      Object.keys(message).length !== MESSAGE_FIELDS.length || Object.keys(message).some(k => !MESSAGE_FIELDS.includes(k))) {
    throw new Error('Invalid signed key envelope');
  }
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) throw new Error('Invalid key envelope timestamp');
  const checked = verifyPeerMessage(message, { now: message.timestamp, maxClockSkewMs: 0 });
  if (!checked.ok) throw new Error(`Invalid key envelope signature: ${checked.reason}`);
  if (expectedSenderNodeId !== undefined && checked.nodeId !== expectedSenderNodeId) throw new Error('Unexpected key envelope sender');
  const payload = checked.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== ENVELOPE_FIELDS.length || Object.keys(payload).some(k => !ENVELOPE_FIELDS.includes(k)) ||
      payload.type !== 'FILE_KEY_ENVELOPE' || payload.protocol !== PROTOCOL ||
      !CID.test(payload.cid ?? '') || !/^[a-f0-9]{64}$/.test(payload.recipientKeyId ?? '') ||
      typeof payload.ephemeralPublicKeyPem !== 'string' || payload.ephemeralPublicKeyPem.length > 8192) {
    throw new Error('Invalid key envelope payload');
  }
  if (expectedCid !== undefined && payload.cid !== expectedCid) throw new Error('Key envelope content identifier mismatch');

  const recipientPrivateKey = parsePrivateKey(recipientPrivateKeyPem);
  const recipientPublicKey = createPublicKey(recipientPrivateKey);
  if (publicKeyId(recipientPublicKey) !== payload.recipientKeyId) throw new Error('Key envelope targets another recipient');
  const ephemeralPublicKey = parsePublicKey(payload.ephemeralPublicKeyPem);
  const salt = decodeBase64(payload.salt, 32, 'key envelope salt');
  const nonce = decodeBase64(payload.nonce, 12, 'key envelope nonce');
  const ciphertext = decodeBase64(payload.ciphertext, KEY_BYTES, 'wrapped file key');
  const tag = decodeBase64(payload.tag, 16, 'key envelope tag');
  let sharedSecret;
  let wrappingKey;
  try {
    sharedSecret = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralPublicKey });
    wrappingKey = Buffer.from(hkdfSync('sha256', sharedSecret, salt, Buffer.from(PROTOCOL), KEY_BYTES));
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce);
    decipher.setAAD(aad({ cid: payload.cid, recipientKeyId: payload.recipientKeyId, senderNodeId: checked.nodeId }));
    decipher.setAuthTag(tag);
    const fileKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (fileKey.length !== KEY_BYTES) { fileKey.fill(0); throw new Error('Invalid unwrapped file key length'); }
    return Object.freeze({ cid: payload.cid, senderNodeId: checked.nodeId, recipientKeyId: payload.recipientKeyId, fileKey });
  } finally {
    salt.fill(0); nonce.fill(0); ciphertext.fill(0); tag.fill(0);
    sharedSecret?.fill(0); wrappingKey?.fill(0);
  }
}
