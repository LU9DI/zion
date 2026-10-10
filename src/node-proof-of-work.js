import { createHash, timingSafeEqual, createPublicKey } from 'node:crypto';

const HEX_256 = /^[a-f0-9]{64}$/;
const MAX_DIFFICULTY_BITS = 28;
const MAX_NONCE = 0xffffffffffffffffn;

function digestFor(publicKeyPem, nonce) {
  return createHash('sha256')
    .update('zion-node-pow-v1\0', 'utf8')
    .update(publicKeyPem, 'utf8')
    .update('\0', 'utf8')
    .update(nonce.toString(10), 'utf8')
    .digest();
}

function hasLeadingZeroBits(digest, difficultyBits) {
  const fullBytes = Math.floor(difficultyBits / 8);
  const remainingBits = difficultyBits % 8;
  for (let i = 0; i < fullBytes; i++) if (digest[i] !== 0) return false;
  if (remainingBits && (digest[fullBytes] >> (8 - remainingBits)) !== 0) return false;
  return true;
}

export function verifyNodeProofOfWork({ publicKeyPem, nonce, difficultyBits, expectedNodeId } = {}) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length < 32 || publicKeyPem.length > 8192) return false;
  if (typeof nonce !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(nonce)) return false;
  if (BigInt(nonce) > MAX_NONCE) return false;
  if (!Number.isSafeInteger(difficultyBits) || difficultyBits < 0 || difficultyBits > MAX_DIFFICULTY_BITS) return false;
  if (typeof expectedNodeId !== 'string' || !HEX_256.test(expectedNodeId)) return false;
  const digest = digestFor(publicKeyPem, BigInt(nonce));
  const idBytes = Buffer.from(expectedNodeId, 'hex');
  const actualId = createHash('sha256').update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('hex');
  if (!timingSafeEqual(idBytes, Buffer.from(actualId, 'hex'))) return false;
  return hasLeadingZeroBits(digest, difficultyBits);
}

/**
 * Performs a one-time admission puzzle bound to the public-key representation.
 * Difficulty is explicitly configured by the network policy; elapsed time is
 * hardware-dependent and must never be promised as a fixed 1–2 minute cost.
 */
export async function solveNodeProofOfWork({
  publicKeyPem, nodeId, difficultyBits = 18, startNonce = 0n,
  maxAttempts = 50_000_000, signal, yieldEvery = 20_000,
} = {}) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.length < 32 || publicKeyPem.length > 8192) throw new TypeError('Invalid public key');
  if (typeof nodeId !== 'string' || !HEX_256.test(nodeId)) throw new TypeError('Invalid node ID');
  if (!Number.isSafeInteger(difficultyBits) || difficultyBits < 0 || difficultyBits > MAX_DIFFICULTY_BITS) throw new RangeError('difficultyBits must be between 0 and 28');
  if (typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100_000_000) throw new RangeError('Invalid maxAttempts');
  if (typeof yieldEvery !== 'number' || !Number.isSafeInteger(yieldEvery) || yieldEvery < 1) throw new RangeError('Invalid yieldEvery');
  let nonce = BigInt(startNonce);
  if (nonce < 0n || nonce > MAX_NONCE) throw new RangeError('Invalid startNonce');
  const startedAt = Date.now();
  for (let attempts = 0; attempts < maxAttempts; attempts++, nonce++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Proof-of-work cancelled');
    if (nonce > MAX_NONCE) throw new RangeError('Nonce space exhausted');
    const digest = digestFor(publicKeyPem, nonce);
    if (hasLeadingZeroBits(digest, difficultyBits)) {
      return Object.freeze({ nodeId, nonce: nonce.toString(), difficultyBits, attempts: attempts + 1, elapsedMs: Date.now() - startedAt });
    }
    if ((attempts + 1) % yieldEvery === 0) await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Proof-of-work attempt limit reached');
}
