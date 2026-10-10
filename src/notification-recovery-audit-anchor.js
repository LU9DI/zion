import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify({
  schemaVersion: value.schemaVersion,
  registryRevision: value.registryRevision,
  registryStateSha256: value.registryStateSha256,
  auditHeadSha256: value.auditHeadSha256,
  signerKeyId: value.signerKeyId,
  issuedAt: value.issuedAt,
  previousCheckpointSha256: value.previousCheckpointSha256 ?? null,
});
const fail = (code, message) => Object.assign(new Error(message), { code });
const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Creates and verifies signed checkpoints for a trust registry. Persistence is intentionally
 * delegated to an independent anchor adapter; writing a checkpoint beside the registry alone
 * does not protect against an administrator who can rewrite both files.
 */
export class NotificationRecoveryAuditAnchor {
  static createCheckpoint({ registryPath, signerKeyId, privateKey, issuedAt = Date.now(), previousCheckpoint } = {}) {
    if (typeof registryPath !== 'string' || !registryPath.trim()) throw new TypeError('registryPath is required');
    if (typeof signerKeyId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(signerKeyId)) throw new TypeError('Invalid signerKeyId');
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError('Invalid issuedAt');
    const stat = lstatSync(resolve(registryPath));
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('NOTIFICATION_AUDIT_ANCHOR_UNSAFE_REGISTRY', 'Registry must be a regular non-symlink file');
    const state = JSON.parse(readFileSync(resolve(registryPath), 'utf8'));
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.stateSha256 !== 'string' || !state.keys || typeof state.keys !== 'object' || !Array.isArray(state.events)) {
      throw fail('NOTIFICATION_AUDIT_ANCHOR_INVALID_REGISTRY', 'Registry state is invalid');
    }
    const registryCanonical = JSON.stringify({ schemaVersion: state.schemaVersion, revision: state.revision, keys: state.keys, events: state.events });
    if (sha256(registryCanonical) !== state.stateSha256) throw fail('NOTIFICATION_AUDIT_ANCHOR_INVALID_REGISTRY', 'Registry digest verification failed');
    const previousHash = previousCheckpoint ? NotificationRecoveryAuditAnchor.checkpointSha256(previousCheckpoint) : null;
    if (previousCheckpoint && !NotificationRecoveryAuditAnchor.verifyCheckpointShape(previousCheckpoint)) throw fail('NOTIFICATION_AUDIT_ANCHOR_INVALID_PREVIOUS', 'Previous checkpoint is malformed');
    const checkpoint = {
      schemaVersion: 1,
      registryRevision: state.revision,
      registryStateSha256: state.stateSha256,
      auditHeadSha256: state.events.at(-1)?.eventHash ?? '0'.repeat(64),
      signerKeyId,
      issuedAt,
      previousCheckpointSha256: previousHash,
    };
    const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Audit anchor signing key must be Ed25519');
    const payload = Buffer.from(canonical(checkpoint));
    return Object.freeze({ ...checkpoint, signature: sign(null, payload, key).toString('base64') });
  }

  static verifyCheckpoint(checkpoint, { publicKey, expectedSignerKeyId, now = Date.now(), maxAgeMs = Infinity } = {}) {
    if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(checkpoint)) return { valid: false, code: 'malformed-checkpoint' };
    if (expectedSignerKeyId !== undefined && checkpoint.signerKeyId !== expectedSignerKeyId) return { valid: false, code: 'unexpected-signer' };
    if (!Number.isSafeInteger(now) || now < 0 || !(maxAgeMs === Infinity || (Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0))) throw new TypeError('Invalid verification time policy');
    if (checkpoint.issuedAt > now) return { valid: false, code: 'issued-in-future' };
    if (now - checkpoint.issuedAt > maxAgeMs) return { valid: false, code: 'checkpoint-too-old' };
    try {
      const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') return { valid: false, code: 'wrong-key-type' };
      const valid = verify(null, Buffer.from(canonical(checkpoint)), key, Buffer.from(checkpoint.signature, 'base64'));
      return valid ? { valid: true, checkpointSha256: NotificationRecoveryAuditAnchor.checkpointSha256(checkpoint) } : { valid: false, code: 'signature-invalid' };
    } catch { return { valid: false, code: 'invalid-public-key' }; }
  }

  static compareWithTrustedCheckpoint({ trusted, observed } = {}) {
    if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(trusted) || !NotificationRecoveryAuditAnchor.verifyCheckpointShape(observed)) return { consistent: false, code: 'malformed-checkpoint' };
    if (observed.registryRevision < trusted.registryRevision) return { consistent: false, code: 'rollback-detected' };
    if (observed.registryRevision === trusted.registryRevision) {
      if (observed.registryStateSha256 !== trusted.registryStateSha256 || observed.auditHeadSha256 !== trusted.auditHeadSha256) return { consistent: false, code: 'same-revision-fork' };
      return { consistent: true, code: 'same-state' };
    }
    if (observed.previousCheckpointSha256 !== NotificationRecoveryAuditAnchor.checkpointSha256(trusted)) return { consistent: false, code: 'checkpoint-chain-break' };
    return { consistent: true, code: 'advanced' };
  }

  static checkpointSha256(checkpoint) {
    if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(checkpoint)) throw new TypeError('Malformed checkpoint');
    return sha256(JSON.stringify({ ...JSON.parse(canonical(checkpoint)), signature: checkpoint.signature }));
  }

  static verifyCheckpointShape(checkpoint) {
    return Boolean(checkpoint && checkpoint.schemaVersion === 1 && Number.isSafeInteger(checkpoint.registryRevision) && checkpoint.registryRevision >= 0 && HASH_RE.test(checkpoint.registryStateSha256 ?? '') && HASH_RE.test(checkpoint.auditHeadSha256 ?? '') && typeof checkpoint.signerKeyId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(checkpoint.signerKeyId) && Number.isSafeInteger(checkpoint.issuedAt) && checkpoint.issuedAt >= 0 && (checkpoint.previousCheckpointSha256 === null || HASH_RE.test(checkpoint.previousCheckpointSha256 ?? '')) && typeof checkpoint.signature === 'string' && checkpoint.signature.length > 0);
  }
}
