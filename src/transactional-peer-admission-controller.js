import { verifyPeerIntroductionVouchers } from './peer-introduction-vouchers.js';

const NODE_ID = /^[a-f0-9]{64}$/;

/**
 * Admission controller for a shared transactional store.
 * The store, not this process, is authoritative for uniqueness, quotas, and capacity.
 * A live capacity provider is still required for current storage-headroom and rollout policy.
 */
export class TransactionalPeerAdmissionController {
  constructor({
    trustedIssuerNodeIds, threshold = 2, maxActivePeers = 100,
    maxAdmissionsPerIssuer = 5, minStorageHeadroomRatio = 0.1,
    maxVouchers = 16, now = () => Date.now(), capacityProvider,
    admissionStore, rolloutPolicy = null,
  } = {}) {
    if (!Array.isArray(trustedIssuerNodeIds) || trustedIssuerNodeIds.some(id => !NODE_ID.test(id)) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 16 ||
      !Number.isSafeInteger(maxActivePeers) || maxActivePeers < 1 ||
      !Number.isSafeInteger(maxAdmissionsPerIssuer) || maxAdmissionsPerIssuer < 1 ||
      !Number.isFinite(minStorageHeadroomRatio) || minStorageHeadroomRatio < 0 || minStorageHeadroomRatio > 1 ||
      !Number.isSafeInteger(maxVouchers) || maxVouchers < threshold || maxVouchers > 64 ||
      typeof now !== 'function' || typeof capacityProvider !== 'function' ||
      !admissionStore || typeof admissionStore.commitAdmission !== 'function' ||
      typeof admissionStore.isAdmitted !== 'function' ||
      typeof admissionStore.snapshot !== 'function' ||
      (rolloutPolicy !== null && typeof rolloutPolicy.evaluate !== 'function')) {
      throw new TypeError('Invalid transactional peer admission configuration');
    }
    this.trusted = [...new Set(trustedIssuerNodeIds)];
    this.threshold = threshold;
    this.maxActivePeers = maxActivePeers;
    this.maxAdmissionsPerIssuer = maxAdmissionsPerIssuer;
    this.minStorageHeadroomRatio = minStorageHeadroomRatio;
    this.maxVouchers = maxVouchers;
    this.now = now;
    this.capacityProvider = capacityProvider;
    this.admissionStore = admissionStore;
    this.rolloutPolicy = rolloutPolicy;
  }

  async admit({ subjectNodeId, vouchers } = {}) {
    if (!NODE_ID.test(subjectNodeId ?? '') || !Array.isArray(vouchers) ||
      vouchers.length < this.threshold || vouchers.length > this.maxVouchers) {
      return { ok: false, reason: 'invalid-input' };
    }

    const capacity = await this.capacityProvider();
    if (!capacity || !Number.isSafeInteger(capacity.activePeers) || capacity.activePeers < 0 ||
      !Number.isSafeInteger(capacity.maxPeers) || capacity.maxPeers < 1 ||
      !Number.isFinite(capacity.storageHeadroomRatio) || capacity.storageHeadroomRatio < 0 ||
      capacity.storageHeadroomRatio > 1) {
      return { ok: false, reason: 'capacity-unavailable' };
    }
    const rollout = this.rolloutPolicy?.evaluate(capacity);
    if (rollout && !rollout.allowed) return { ok: false, reason: rollout.reason };
    const rolloutCap = rollout?.stageCap ?? Number.MAX_SAFE_INTEGER;
    if (capacity.activePeers >= Math.min(capacity.maxPeers, this.maxActivePeers, rolloutCap)) {
      return { ok: false, reason: 'peer-capacity-reached' };
    }
    if (capacity.storageHeadroomRatio < this.minStorageHeadroomRatio) {
      return { ok: false, reason: 'storage-headroom-too-low' };
    }

    const accepted = new Map();
    for (const voucher of vouchers) {
      const check = verifyPeerIntroductionVouchers({
        subjectNodeId, vouchers: [voucher], trustedIssuerNodeIds: this.trusted,
        threshold: 1, now: this.now(), maxVouchers: 1,
      });
      if (!check.ok || accepted.has(voucher.issuerNodeId) || accepted.size >= this.maxVouchers) continue;
      accepted.set(voucher.issuerNodeId, voucher);
    }
    if (accepted.size < this.threshold) return { ok: false, reason: 'insufficient-valid-invitations' };

    const issuerNodeIds = [...accepted.keys()];
    return this.admissionStore.commitAdmission({
      subjectNodeId,
      issuerNodeIds,
      invitations: [...accepted.values()].map(voucher => ({
        issuerNodeId: voucher.issuerNodeId,
        nonce: voucher.nonce,
      })),
      storageHeadroomRatio: capacity.storageHeadroomRatio,
      maxActivePeers: Math.min(this.maxActivePeers, capacity.maxPeers, rolloutCap),
      maxAdmissionsPerIssuer: this.maxAdmissionsPerIssuer,
    });
  }

  isAdmitted(subjectNodeId) {
    if (!NODE_ID.test(subjectNodeId ?? '')) return Promise.resolve(false);
    return this.admissionStore.isAdmitted(subjectNodeId);
  }

  snapshot() {
    return this.admissionStore.snapshot();
  }

  release(subjectNodeId, status = 'released') {
    return this.admissionStore.releaseAdmission(subjectNodeId, status);
  }
}
