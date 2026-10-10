import { NotificationRecoveryAuditAnchor } from './notification-recovery-audit-anchor.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Adapter boundary for a checkpoint destination outside the registry's storage domain.
 * The included memory adapter is for tests only; production adapters must provide their own
 * authentication, durable writes, access control, and independent operational boundary.
 */
export class NotificationRecoveryIndependentAnchor {
  constructor({ adapter, publicKey, expectedSignerKeyId, now = () => Date.now(), maxAgeMs = Infinity } = {}) {
    if (!adapter || typeof adapter.publish !== 'function' || typeof adapter.getLatest !== 'function') throw new TypeError('An anchor adapter implementing publish and getLatest is required');
    if (!publicKey) throw new TypeError('Trusted anchor publicKey is required');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.adapter = adapter;
    this.publicKey = publicKey;
    this.expectedSignerKeyId = expectedSignerKeyId;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
  }

  async publish(checkpoint) {
    const verified = NotificationRecoveryAuditAnchor.verifyCheckpoint(checkpoint, {
      publicKey: this.publicKey, expectedSignerKeyId: this.expectedSignerKeyId,
      now: this.now(), maxAgeMs: this.maxAgeMs,
    });
    if (!verified.valid) throw fail('NOTIFICATION_ANCHOR_CHECKPOINT_UNTRUSTED', `Checkpoint rejected: ${verified.code}`);
    const current = await this.adapter.getLatest();
    if (current) {
      const comparison = NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: current, observed: checkpoint });
      if (!comparison.consistent) throw fail('NOTIFICATION_ANCHOR_CONFLICT', `Anchor refused: ${comparison.code}`);
      if (comparison.code === 'same-state') return { published: false, idempotent: true, checkpointSha256: verified.checkpointSha256 };
    } else if (checkpoint.previousCheckpointSha256 !== null) {
      throw fail('NOTIFICATION_ANCHOR_MISSING_ANCESTRY', 'First published checkpoint must not reference an unavailable predecessor');
    }
    const result = await this.adapter.publish(checkpoint);
    if (result?.stored !== true) throw fail('NOTIFICATION_ANCHOR_PUBLISH_UNCONFIRMED', 'Adapter did not confirm durable publication');
    const readBack = await this.adapter.getLatest();
    if (!readBack || NotificationRecoveryAuditAnchor.checkpointSha256(readBack) !== verified.checkpointSha256) {
      throw fail('NOTIFICATION_ANCHOR_READBACK_MISMATCH', 'Published checkpoint did not match read-back');
    }
    if (result.idempotent === true) return { published: false, idempotent: true, checkpointSha256: verified.checkpointSha256 };
    return { published: true, idempotent: false, checkpointSha256: verified.checkpointSha256 };
  }

  async verifyLatest({ trustedCheckpoint } = {}) {
    let observed;
    try { observed = await this.adapter.getLatest(); }
    catch { return { valid: false, code: 'anchor-unavailable' }; }
    if (!observed) return { valid: false, code: 'anchor-empty' };
    const signature = NotificationRecoveryAuditAnchor.verifyCheckpoint(observed, {
      publicKey: this.publicKey, expectedSignerKeyId: this.expectedSignerKeyId,
      now: this.now(), maxAgeMs: this.maxAgeMs,
    });
    if (!signature.valid) return { valid: false, code: `checkpoint-${signature.code}` };
    if (trustedCheckpoint) {
      const comparison = NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: trustedCheckpoint, observed });
      if (!comparison.consistent) return { valid: false, code: comparison.code };
    }
    return { valid: true, code: 'verified', checkpoint: observed, checkpointSha256: signature.checkpointSha256 };
  }
}

/** Test-only adapter. Do not use as an independent production trust domain. */
export class MemoryNotificationAnchorAdapter {
  #checkpoint = null;
  #available = true;
  setAvailable(value) { this.#available = Boolean(value); }
  async getLatest() {
    if (!this.#available) throw fail('NOTIFICATION_ANCHOR_UNAVAILABLE', 'Anchor destination unavailable');
    return this.#checkpoint ? structuredClone(this.#checkpoint) : null;
  }
  async publish(checkpoint) {
    if (!this.#available) throw fail('NOTIFICATION_ANCHOR_UNAVAILABLE', 'Anchor destination unavailable');
    if (this.#checkpoint) {
      const currentHash = NotificationRecoveryAuditAnchor.checkpointSha256(this.#checkpoint);
      const incomingHash = NotificationRecoveryAuditAnchor.checkpointSha256(checkpoint);
      if (currentHash === incomingHash) return { stored: true, idempotent: true };
      const comparison = NotificationRecoveryAuditAnchor.compareWithTrustedCheckpoint({ trusted: this.#checkpoint, observed: checkpoint });
      if (!comparison.consistent || comparison.code !== 'advanced') throw fail('NOTIFICATION_ANCHOR_CONFLICT', `Cannot replace checkpoint: ${comparison.code}`);
    }
    this.#checkpoint = structuredClone(checkpoint);
    return { stored: true };
  }
}
