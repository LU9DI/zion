import { verifyPeerIntroductionVouchers } from './peer-introduction-vouchers.js';

const ID = /^[a-f0-9]{64}$/;

/**
 * Async admission facade for PostgresPeerAdmissionStore.
 * Unlike the local file-backed controller, every authorization read is
 * authoritative against PostgreSQL. The store migration must be applied first.
 */
export class PostgresPeerAdmissionController {
  constructor({
    store, trustedIssuerNodeIds, threshold = 2, maxVouchers = 16,
    maxActivePeers = 100, maxAdmissionsPerIssuer = 5,
    minStorageHeadroomRatio = 0.1, capacityProvider, now = () => Date.now(),
  } = {}) {
    if (!store || typeof store.commitAdmission !== 'function' ||
      typeof store.getAdmissionStatus !== 'function' ||
      typeof store.revokeAdmission !== 'function' ||
      !Array.isArray(trustedIssuerNodeIds) ||
      trustedIssuerNodeIds.some(id => !ID.test(id)) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 16 ||
      !Number.isSafeInteger(maxVouchers) || maxVouchers < threshold || maxVouchers > 64 ||
      !Number.isSafeInteger(maxActivePeers) || maxActivePeers < 1 ||
      !Number.isSafeInteger(maxAdmissionsPerIssuer) || maxAdmissionsPerIssuer < 1 ||
      !Number.isFinite(minStorageHeadroomRatio) || minStorageHeadroomRatio < 0 ||
      minStorageHeadroomRatio > 1 || typeof capacityProvider !== 'function' ||
      typeof now !== 'function') {
      throw new TypeError('Invalid PostgreSQL peer-admission controller configuration');
    }
    this.store = store;
    this.trustedIssuerNodeIds = [...new Set(trustedIssuerNodeIds)];
    this.threshold = threshold;
    this.maxVouchers = maxVouchers;
    this.maxActivePeers = maxActivePeers;
    this.maxAdmissionsPerIssuer = maxAdmissionsPerIssuer;
    this.minStorageHeadroomRatio = minStorageHeadroomRatio;
    this.capacityProvider = capacityProvider;
    this.now = now;
  }

  async isAdmitted(subjectNodeId) {
    const result = await this.store.getAdmissionStatus(subjectNodeId);
    return result?.ok === true && result.status === 'active';
  }

  async admit({ subjectNodeId, vouchers } = {}) {
    if (!ID.test(subjectNodeId ?? '') || !Array.isArray(vouchers) ||
      vouchers.length < this.threshold || vouchers.length > this.maxVouchers) {
      return { ok: false, reason: 'invalid-input' };
    }
    const now = this.now();
    const accepted = new Map();
    for (const voucher of vouchers) {
      if (!voucher || accepted.has(voucher.issuerNodeId)) continue;
      const verified = verifyPeerIntroductionVouchers({
        subjectNodeId, vouchers: [voucher],
        trustedIssuerNodeIds: this.trustedIssuerNodeIds,
        threshold: 1, now, maxVouchers: 1,
      });
      if (verified.ok) accepted.set(voucher.issuerNodeId, voucher);
    }
    if (accepted.size < this.threshold) {
      return { ok: false, reason: 'insufficient-valid-invitations' };
    }
    const capacity = await this.capacityProvider();
    if (!capacity || !Number.isSafeInteger(capacity.activePeers) ||
      capacity.activePeers < 0 || !Number.isSafeInteger(capacity.maxPeers) ||
      capacity.maxPeers < 1 || !Number.isFinite(capacity.storageHeadroomRatio) ||
      capacity.storageHeadroomRatio < 0 || capacity.storageHeadroomRatio > 1) {
      return { ok: false, reason: 'capacity-unavailable' };
    }
    if (capacity.activePeers >= Math.min(capacity.maxPeers, this.maxActivePeers)) {
      return { ok: false, reason: 'peer-capacity-reached' };
    }
    if (capacity.storageHeadroomRatio < this.minStorageHeadroomRatio) {
      return { ok: false, reason: 'storage-headroom-too-low' };
    }
    return this.store.commitAdmission({
      subjectNodeId,
      issuerNodeIds: [...accepted.keys()],
      invitations: [...accepted.values()].map(voucher => ({
        issuerNodeId: voucher.issuerNodeId, nonce: voucher.nonce,
      })),
      storageHeadroomRatio: capacity.storageHeadroomRatio,
      maxActivePeers: Math.min(capacity.maxPeers, this.maxActivePeers),
      maxAdmissionsPerIssuer: this.maxAdmissionsPerIssuer,
    });
  }

  revoke(subjectNodeId) {
    return this.store.revokeAdmission(subjectNodeId);
  }
}
