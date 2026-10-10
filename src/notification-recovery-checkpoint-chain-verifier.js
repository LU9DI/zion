import { NotificationRecoveryAuditAnchor } from './notification-recovery-audit-anchor.js';

/**
 * Read-only verifier for an explicitly supplied ordered checkpoint history.
 * It verifies every signature and requires a linked, strictly advancing revision chain.
 * A single latest checkpoint cannot prove the omitted history; callers must supply the history
 * or a previously trusted checkpoint to establish the starting point.
 */
export function verifyNotificationRecoveryCheckpointChain({
  checkpoints,
  publicKey,
  expectedSignerKeyId,
  now = Date.now(),
  maxAgeMs = Infinity,
  trustedCheckpoint,
} = {}) {
  if (!Array.isArray(checkpoints)) throw new TypeError('checkpoints must be an array');
  if (!publicKey) throw new TypeError('publicKey is required');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a non-negative safe integer');
  if (!(maxAgeMs === Infinity || (Number.isSafeInteger(maxAgeMs) && maxAgeMs >= 0))) throw new TypeError('maxAgeMs must be Infinity or a non-negative safe integer');
  if (trustedCheckpoint && !NotificationRecoveryAuditAnchor.verifyCheckpointShape(trustedCheckpoint)) {
    return { valid: false, code: 'trusted-checkpoint-malformed', index: null, verifiedCount: 0 };
  }
  if (checkpoints.length === 0) {
    return trustedCheckpoint
      ? { valid: false, code: 'history-empty', index: null, verifiedCount: 0 }
      : { valid: false, code: 'history-empty', index: null, verifiedCount: 0 };
  }

  let previous = trustedCheckpoint ?? null;
  let verifiedCount = 0;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    const signature = NotificationRecoveryAuditAnchor.verifyCheckpoint(checkpoint, {
      publicKey, expectedSignerKeyId, now, maxAgeMs,
    });
    if (!signature.valid) return { valid: false, code: `checkpoint-${signature.code}`, index, verifiedCount };

    if (previous === null) {
      if (checkpoint.previousCheckpointSha256 !== null) {
        return { valid: false, code: 'checkpoint-chain-start-missing', index, verifiedCount };
      }
    } else {
      const comparison = NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: previous, observed: checkpoint });
      if (!comparison.consistent) return { valid: false, code: comparison.code, index, verifiedCount };
      if (comparison.code !== 'advanced') {
        return { valid: false, code: comparison.code === 'same-state' ? 'duplicate-or-nonadvancing-checkpoint' : comparison.code, index, verifiedCount };
      }
    }
    previous = checkpoint;
    verifiedCount += 1;
  }

  return {
    valid: true,
    code: 'verified',
    verifiedCount,
    firstRevision: checkpoints[0].registryRevision,
    lastRevision: checkpoints.at(-1).registryRevision,
    lastCheckpointSha256: NotificationRecoveryAuditAnchor.checkpointSha256(checkpoints.at(-1)),
  };
}
