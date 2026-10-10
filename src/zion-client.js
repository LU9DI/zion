import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { screenContentHashLocally } from './content-admission-policy.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024;

function validateAdapter(adapter) {
  if (!adapter || typeof adapter.putChunk !== 'function' || typeof adapter.getChunk !== 'function') {
    throw new TypeError('storageAdapter must implement putChunk({ id, ciphertext }) and getChunk(id)');
  }
}
function manifestPayload(manifest) {
  const { cid, ...payload } = manifest;
  return payload;
}
function calculateCid(manifest) { return sha256(Buffer.from(stableJson(manifestPayload(manifest)))); }
function encryptChunk(plain, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('ZION-CONSUMER-CLIENT-v1'));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('ZC1'), nonce, cipher.getAuthTag(), ciphertext]);
}
function decryptChunk(envelope, key) {
  if (!Buffer.isBuffer(envelope) || envelope.length < 31 || envelope.subarray(0, 3).toString() !== 'ZC1') throw new Error('invalid-encrypted-chunk');
  const nonce = envelope.subarray(3, 15);
  const tag = envelope.subarray(15, 31);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from('ZION-CONSUMER-CLIENT-v1'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(31)), decipher.final()]);
}

/**
 * Consumer-facing abstraction over Zion storage. The adapter receives ciphertext only;
 * file keys remain client-side and must be shared with recipients through a separate secure channel.
 * This class does not claim ZKP, distributed consensus, or a production network adapter.
 */
export class ZionClient {
  constructor({ storageAdapter, moderationRegistry = null, blacklistSha256 = [], chunkBytes = DEFAULT_CHUNK_BYTES, maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
    validateAdapter(storageAdapter);
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 16 * 1024 * 1024) throw new RangeError('chunkBytes must be from 1 byte to 16 MiB');
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 2 * 1024 * 1024 * 1024) throw new RangeError('maxFileBytes must be from 1 byte to 2 GiB');
    this.storageAdapter = storageAdapter;
    this.moderationRegistry = moderationRegistry;
    this.blacklistSha256 = [...blacklistSha256];
    this.chunkBytes = chunkBytes;
    this.maxFileBytes = maxFileBytes;
  }

  async upload(input, { blacklistSha256 = this.blacklistSha256 } = {}) {
    const content = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input);
    if (content.length > this.maxFileBytes) throw Object.assign(new RangeError('file-size-limit'), { code: 'ZION_FILE_SIZE_LIMIT' });
    const screening = screenContentHashLocally(content, { blacklistSha256, maxBytes: this.maxFileBytes });
    if (!screening.accepted) throw Object.assign(new Error(`content-rejected:${screening.reason}`), { code: 'ZION_CONTENT_REJECTED', reason: screening.reason });

    const fileKey = randomBytes(32);
    const chunkEntries = [];
    const written = [];
    const totalChunks = Math.max(1, Math.ceil(content.length / this.chunkBytes));
    try {
      for (let index = 0; index < totalChunks; index += 1) {
        const plain = content.subarray(index * this.chunkBytes, Math.min(content.length, (index + 1) * this.chunkBytes));
        const ciphertext = encryptChunk(plain, fileKey);
        const id = sha256(ciphertext);
        const stored = await this.storageAdapter.putChunk({ id, ciphertext: Buffer.from(ciphertext) });
        if (stored?.created === true) written.push(id);
        chunkEntries.push({ id, index, plaintextBytes: plain.length, ciphertextBytes: ciphertext.length });
      }
    } catch (error) {
      // Best-effort cleanup only for chunks newly acknowledged by this operation. Shared/deduplicated
      // adapters should implement reference counting before enabling deleteChunk here.
      if (typeof this.storageAdapter.rollbackChunk === 'function') {
        for (const id of written.reverse()) await this.storageAdapter.rollbackChunk(id).catch(() => {});
      }
      fileKey.fill(0);
      throw error;
    }

    const manifest = {
      schemaVersion: 1,
      protocol: 'zion-client-encrypted-chunks-v1',
      createdAt: Date.now(),
      plaintextBytes: content.length,
      chunkCount: chunkEntries.length,
      chunks: chunkEntries,
    };
    manifest.cid = calculateCid(manifest);
    return Object.freeze({
      cid: manifest.cid,
      manifest: Object.freeze({ ...manifest, chunks: Object.freeze(chunkEntries.map(entry => Object.freeze({ ...entry }))) }),
      fileKey: fileKey.toString('base64'),
      screening: Object.freeze({ accepted: true, reason: 'clear', bytes: content.length }),
      privacy: 'plaintext-and-file-key-remain-client-side',
    });
  }

  async download({ cid, manifest, fileKey }) {
    if (!manifest || manifest.schemaVersion !== 1 || manifest.protocol !== 'zion-client-encrypted-chunks-v1' || !Array.isArray(manifest.chunks)) throw new Error('invalid-manifest');
    if (calculateCid(manifest) !== manifest.cid || cid !== undefined && cid !== manifest.cid) throw new Error('manifest-cid-mismatch');
    if (this.moderationRegistry?.isBlocked(manifest.cid)) throw Object.assign(new Error('content-blocked-by-gateway-policy'), { code: 'ZION_CONTENT_BLOCKED' });
    if (!Number.isSafeInteger(manifest.plaintextBytes) || manifest.plaintextBytes < 0 || manifest.plaintextBytes > this.maxFileBytes || manifest.chunks.length !== manifest.chunkCount) throw new Error('manifest-bounds-invalid');
    const key = Buffer.from(fileKey ?? '', 'base64');
    if (key.length !== 32) { key.fill(0); throw new Error('invalid-file-key'); }
    try {
      const parts = [];
      let total = 0;
      for (let index = 0; index < manifest.chunks.length; index += 1) {
        const entry = manifest.chunks[index];
        if (!entry || entry.index !== index || !/^[a-f0-9]{64}$/.test(entry.id) || !Number.isSafeInteger(entry.ciphertextBytes) || entry.ciphertextBytes < 31 || entry.ciphertextBytes > this.chunkBytes + 31 || !Number.isSafeInteger(entry.plaintextBytes) || entry.plaintextBytes < 0 || entry.plaintextBytes > this.chunkBytes) throw new Error('manifest-chunk-invalid');
        const ciphertext = await this.storageAdapter.getChunk(entry.id);
        if (!Buffer.isBuffer(ciphertext) || ciphertext.length !== entry.ciphertextBytes || sha256(ciphertext) !== entry.id) throw new Error('ciphertext-integrity-failed');
        const plaintext = decryptChunk(ciphertext, key);
        if (plaintext.length !== entry.plaintextBytes) throw new Error('plaintext-length-mismatch');
        total += plaintext.length;
        if (total > this.maxFileBytes) throw new Error('file-size-limit');
        parts.push(plaintext);
      }
      if (total !== manifest.plaintextBytes) throw new Error('manifest-total-length-mismatch');
      return Buffer.concat(parts, total);
    } finally { key.fill(0); }
  }

  async delete(cid, manifest) {
    if (!manifest || manifest.cid !== cid || calculateCid(manifest) !== cid) throw new Error('manifest-cid-mismatch');
    if (typeof this.storageAdapter.releaseChunk !== 'function') throw new Error('storage-adapter-does-not-support-reference-release');
    for (const entry of manifest.chunks) await this.storageAdapter.releaseChunk(entry.id);
    return { deleted: true, cid, chunks: manifest.chunks.length, warning: 'shared replicas may retain copies' };
  }
}

/** Small test/development adapter. Not a network or durable storage implementation. */
export class MemoryCiphertextAdapter {
  #chunks = new Map();
  #references = new Map();
  async putChunk({ id, ciphertext }) {
    if (!/^[a-f0-9]{64}$/.test(id) || !Buffer.isBuffer(ciphertext) || sha256(ciphertext) !== id) throw new Error('invalid-ciphertext-chunk');
    const prior = this.#chunks.get(id);
    if (prior && !prior.equals(ciphertext)) throw new Error('content-address-collision');
    if (!prior) this.#chunks.set(id, Buffer.from(ciphertext));
    this.#references.set(id, (this.#references.get(id) ?? 0) + 1);
    return { id, created: !prior, stored: !prior };
  }
  async getChunk(id) { const value = this.#chunks.get(id); if (!value) throw Object.assign(new Error('chunk-not-found'), { code: 'ENOENT' }); return Buffer.from(value); }
  async rollbackChunk(id) { this.#chunks.delete(id); this.#references.delete(id); }
  async releaseChunk(id) {
    const count = this.#references.get(id);
    if (!count) return false;
    if (count > 1) this.#references.set(id, count - 1);
    else { this.#references.delete(id); this.#chunks.delete(id); }
    return true;
  }
  get size() { return this.#chunks.size; }
}
