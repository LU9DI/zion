import { createHash, sign, verify, createPublicKey } from 'node:crypto';

const MAX_CHUNKS = 100_000;
const MAX_TOTAL_BYTES = Number.MAX_SAFE_INTEGER;
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Manifest numbers must be safe non-negative integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported manifest value');
};
const nodeIdFor = publicKey => createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

/** Creates a signed, immutable description of encrypted chunks. It never includes file plaintext or encryption keys. */
export function createSignedManifest(identity, chunks, { createdAt = Date.now(), fileId } = {}) {
  if (!identity?.privateKey || typeof identity.publicKeyPem !== 'string') throw new TypeError('A valid node identity is required');
  if (!Array.isArray(chunks) || chunks.length > MAX_CHUNKS) throw new RangeError('Invalid chunk list');
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Invalid creation time');
  const normalized = chunks.map(c => {
    if (!c || !/^[a-f0-9]{64}$/.test(c.id) || !Number.isSafeInteger(c.bytes) || c.bytes < 0) throw new TypeError('Invalid chunk descriptor');
    return { id: c.id, bytes: c.bytes };
  });
  if (new Set(normalized.map(c => c.id)).size !== normalized.length) throw new TypeError('Duplicate chunk IDs are forbidden');
  const totalBytes = normalized.reduce((sum, c) => sum + c.bytes, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) throw new RangeError('Manifest size overflow');
  const core = { version: 1, ownerNodeId: identity.nodeId, publicKeyPem: identity.publicKeyPem, createdAt, fileId: fileId ?? createHash('sha256').update(canonical(normalized)).digest('hex'), totalBytes, chunks: normalized };
  const signature = sign(null, Buffer.from(canonical(core)), identity.privateKey).toString('base64');
  return Object.freeze({ ...core, signature });
}

export function verifySignedManifest(manifest, { maxChunks = MAX_CHUNKS, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  try {
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.chunks) || manifest.chunks.length > maxChunks) return { ok: false, reason: 'invalid-manifest' };
    if (typeof manifest.publicKeyPem !== 'string' || typeof manifest.ownerNodeId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.ownerNodeId)) return { ok: false, reason: 'invalid-identity' };
    if (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0 || typeof manifest.fileId !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.fileId)) return { ok: false, reason: 'invalid-metadata' };
    if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > maxTotalBytes) return { ok: false, reason: 'invalid-size' };
    const ids = new Set(); let total = 0;
    for (const chunk of manifest.chunks) {
      if (!chunk || !/^[a-f0-9]{64}$/.test(chunk.id) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 || ids.has(chunk.id)) return { ok: false, reason: 'invalid-chunk' };
      ids.add(chunk.id); total += chunk.bytes;
      if (!Number.isSafeInteger(total) || total > maxTotalBytes) return { ok: false, reason: 'invalid-size' };
    }
    if (total !== manifest.totalBytes) return { ok: false, reason: 'size-mismatch' };
    const publicKey = createPublicKey(manifest.publicKeyPem);
    if (nodeIdFor(publicKey) !== manifest.ownerNodeId) return { ok: false, reason: 'identity-mismatch' };
    const { signature, ...core } = manifest;
    if (typeof signature !== 'string' || !verify(null, Buffer.from(canonical(core)), publicKey, Buffer.from(signature, 'base64'))) return { ok: false, reason: 'bad-signature' };
    return { ok: true, ownerNodeId: manifest.ownerNodeId, totalBytes: total, chunkCount: manifest.chunks.length };
  } catch { return { ok: false, reason: 'malformed-manifest' }; }
}
