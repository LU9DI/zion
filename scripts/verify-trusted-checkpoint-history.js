import { createHash, createPublicKey } from 'node:crypto';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';
import { verifyNotificationRecoveryAnchorKeyRotation } from '../src/notification-recovery-anchor-key-rotation.js';
import { verifyNotificationRecoveryAnchorKeyRevocations } from '../src/notification-recovery-anchor-key-revocation.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Verify an entire checkpoint history against out-of-band initial trust, signed rotations and revocations. */
export function verifyTrustedCheckpointHistory({ checkpoints, trustPolicy, transitions = [], revocations = [], revocationAuthorityPublicKey, now = Date.now(), maxAgeMs = Infinity, rollbackPolicy } = {}) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return { valid: false, code: 'history-empty', verifiedCount: 0 };
  if (!Number.isSafeInteger(now) || now < 0 || !(maxAgeMs === Infinity || (Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0))) throw new TypeError('Invalid verification time policy');
  if (!trustPolicy || trustPolicy.schemaVersion !== 1 || typeof trustPolicy.signerKeyId !== 'string' || typeof trustPolicy.publicKeyPem !== 'string' || typeof trustPolicy.publicKeySha256 !== 'string') return { valid: false, code: 'initial-trust-policy-invalid', verifiedCount: 0 };
  let initialKey;
  try { initialKey = createPublicKey(trustPolicy.publicKeyPem); } catch { return { valid: false, code: 'initial-trust-key-invalid', verifiedCount: 0 }; }
  if (initialKey.asymmetricKeyType !== 'ed25519' || sha256(initialKey.export({ type: 'spki', format: 'der' })) !== trustPolicy.publicKeySha256) return { valid: false, code: 'initial-trust-fingerprint-mismatch', verifiedCount: 0 };
  const rotation = verifyNotificationRecoveryAnchorKeyRotation({ trustPolicy, transitions, now, maxAgeMs });
  if (!rotation.valid) return { valid: false, code: rotation.code, verifiedCount: rotation.verifiedCount ?? 0, index: rotation.index };
  const keys = new Map([[trustPolicy.signerKeyId, initialKey]]);
  for (const transition of transitions) {
    try { keys.set(transition.signerKeyId, createPublicKey(transition.publicKeyPem)); } catch { return { valid: false, code: 'transition-public-key-invalid', verifiedCount: 0 }; }
  }
  const revocation = verifyNotificationRecoveryAnchorKeyRevocations({ events: revocations, authorityPublicKey: revocationAuthorityPublicKey, now, maxAgeMs });
  if (!revocation.valid) return { valid: false, code: revocation.code, verifiedCount: 0, index: revocation.index };
  if (revocation.revokedSignerKeyIds.includes(rotation.activeSignerKeyId)) return { valid: false, code: 'active-signer-revoked', verifiedCount: 0, activeSignerKeyId: rotation.activeSignerKeyId };
  let previous = null;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (!NotificationRecoveryAuditAnchor.verifyCheckpointShape(checkpoint)) return { valid: false, code: 'checkpoint-malformed', index, verifiedCount: index };
    const key = keys.get(checkpoint.signerKeyId);
    if (!key) return { valid: false, code: 'checkpoint-signer-untrusted', index, verifiedCount: index, signerKeyId: checkpoint.signerKeyId };
    if (revocation.revokedSignerKeyIds.includes(checkpoint.signerKeyId)) return { valid: false, code: 'checkpoint-signer-revoked', index, verifiedCount: index, signerKeyId: checkpoint.signerKeyId };
    const signature = NotificationRecoveryAuditAnchor.verifyCheckpoint(checkpoint, { publicKey: key, expectedSignerKeyId: checkpoint.signerKeyId, now, maxAgeMs });
    if (!signature.valid) return { valid: false, code: `checkpoint-${signature.code}`, index, verifiedCount: index };
    if (previous === null) {
      if (checkpoint.previousCheckpointSha256 !== null) return { valid: false, code: 'checkpoint-chain-start-missing', index, verifiedCount: index };
    } else {
      const comparison = NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: previous, observed: checkpoint });
      if (!comparison.consistent) return { valid: false, code: comparison.code, index, verifiedCount: index };
      if (comparison.code !== 'advanced') return { valid: false, code: comparison.code === 'same-state' ? 'duplicate-or-nonadvancing-checkpoint' : comparison.code, index, verifiedCount: index };
    }
    previous = checkpoint;
  }
  const lastCheckpointSha256 = NotificationRecoveryAuditAnchor.checkpointSha256(previous);
  if (rollbackPolicy !== undefined) {
    if (!rollbackPolicy || typeof rollbackPolicy !== 'object' || Array.isArray(rollbackPolicy) || rollbackPolicy.schemaVersion !== 1) return { valid: false, code: 'rollback-policy-invalid', verifiedCount: checkpoints.length };
    const { minimumRevision, minimumHeadIssuedAt, expectedLastCheckpointSha256, maxHeadAgeMs } = rollbackPolicy;
    if (minimumRevision !== undefined && (!Number.isSafeInteger(minimumRevision) || minimumRevision < 0)) return { valid: false, code: 'rollback-policy-invalid', verifiedCount: checkpoints.length };
    if (minimumHeadIssuedAt !== undefined && (!Number.isSafeInteger(minimumHeadIssuedAt) || minimumHeadIssuedAt < 0)) return { valid: false, code: 'rollback-policy-invalid', verifiedCount: checkpoints.length };
    if (expectedLastCheckpointSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedLastCheckpointSha256)) return { valid: false, code: 'rollback-policy-invalid', verifiedCount: checkpoints.length };
    if (maxHeadAgeMs !== undefined && (!Number.isSafeInteger(maxHeadAgeMs) || maxHeadAgeMs < 0)) return { valid: false, code: 'rollback-policy-invalid', verifiedCount: checkpoints.length };
    if (minimumRevision !== undefined && previous.registryRevision < minimumRevision) return { valid: false, code: 'history-rollback-below-minimum-revision', verifiedCount: checkpoints.length, lastRevision: previous.registryRevision, minimumRevision };
    if (minimumHeadIssuedAt !== undefined && previous.issuedAt < minimumHeadIssuedAt) return { valid: false, code: 'history-head-issued-before-minimum', verifiedCount: checkpoints.length, headIssuedAt: previous.issuedAt, minimumHeadIssuedAt };
    if (expectedLastCheckpointSha256 !== undefined && lastCheckpointSha256 !== expectedLastCheckpointSha256) return { valid: false, code: 'history-head-hash-mismatch', verifiedCount: checkpoints.length, lastCheckpointSha256 };
    if (maxHeadAgeMs !== undefined && (previous.issuedAt > now || now - previous.issuedAt > maxHeadAgeMs)) return { valid: false, code: previous.issuedAt > now ? 'history-head-issued-in-future' : 'history-head-too-old', verifiedCount: checkpoints.length, headIssuedAt: previous.issuedAt, maxHeadAgeMs };
  }
  return { valid: true, code: 'verified', verifiedCount: checkpoints.length, firstRevision: checkpoints[0].registryRevision, lastRevision: previous.registryRevision, lastCheckpointSha256, headIssuedAt: previous.issuedAt, activeSignerKeyId: rotation.activeSignerKeyId, rotationCount: rotation.verifiedCount, revocationEventCount: revocation.verifiedCount, rollbackPolicyApplied: rollbackPolicy !== undefined, trustSource: 'out-of-band-initial-policy-plus-signed-rotation-and-revocation-chains' };
}
