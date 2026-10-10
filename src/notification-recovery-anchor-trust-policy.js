import { createHash, createPublicKey } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');

/**
 * Validates an explicitly provisioned trust policy. The policy is a trust input, not
 * self-authenticating evidence: provision or pin it through a separate trusted channel.
 */
export function validateNotificationRecoveryAnchorTrustPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || policy.schemaVersion !== 1) {
    return { valid: false, code: 'trust-policy-schema-invalid' };
  }
  if (typeof policy.signerKeyId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(policy.signerKeyId)) {
    return { valid: false, code: 'trust-policy-signer-invalid' };
  }
  if (typeof policy.publicKeyPem !== 'string' || !policy.publicKeyPem.trim()) {
    return { valid: false, code: 'trust-policy-public-key-missing' };
  }
  if (typeof policy.publicKeySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(policy.publicKeySha256)) {
    return { valid: false, code: 'trust-policy-fingerprint-invalid' };
  }
  try {
    const key = createPublicKey(policy.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return { valid: false, code: 'trust-policy-key-type-invalid' };
    const fingerprint = sha256(key.export({ type: 'spki', format: 'der' }));
    if (fingerprint !== policy.publicKeySha256) return { valid: false, code: 'trust-policy-fingerprint-mismatch' };
    return { valid: true, signerKeyId: policy.signerKeyId, publicKey: key, publicKeySha256: fingerprint };
  } catch {
    return { valid: false, code: 'trust-policy-public-key-invalid' };
  }
}

/** Create a policy document for out-of-band provisioning or pinning. */
export function createNotificationRecoveryAnchorTrustPolicy({ signerKeyId, publicKey } = {}) {
  if (typeof signerKeyId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(signerKeyId)) throw new TypeError('Invalid signerKeyId');
  const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Trust policy requires an Ed25519 public key');
  const publicKeyPem = key.export({ type: 'spki', format: 'pem' });
  return {
    schemaVersion: 1,
    signerKeyId,
    publicKeyPem,
    publicKeySha256: sha256(key.export({ type: 'spki', format: 'der' })),
  };
}
