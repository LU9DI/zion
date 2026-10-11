import { verifyPeerIntroductionVouchers } from './peer-introduction-vouchers.js';

const ID = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;

/**
 * Verifies untrusted vouchers before delegating mutable admission invariants to
 * the PostgreSQL transaction. The transport must use this service rather than
 * calling the raw store with caller-supplied issuer IDs or invitation nonces.
 */
export class VerifiedPostgresPeerAdmissionService {
  constructor({
    store, trustedIssuerNodeIds, threshold = 2, maxVouchers = 16,
    maxActivePeers = 100, maxAdmissionsPerIssuer = 5, now = () => Date.now(),
    storageHeadroomProvider,
  } = {}) {
    if (!store || typeof store.commitAdmission !== 'function' ||
      !Array.isArray(trustedIssuerNodeIds) ||
      trustedIssuerNodeIds.some(id => !ID.test(id)) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 16 ||
      !Number.isSafeInteger(maxVouchers) || maxVouchers < threshold || maxVouchers > 64 ||
      !Number.isSafeInteger(maxActivePeers) || maxActivePeers < 1 ||
      !Number.isSafeInteger(maxAdmissionsPerIssuer) || maxAdmissionsPerIssuer < 1 ||
      typeof now !== 'function' || typeof storageHeadroomProvider !== 'function') {
      throw new TypeError('Invalid verified PostgreSQL admission configuration');
    }
    this.store = store;
    this.trustedIssuerNodeIds = [...new Set(trustedIssuerNodeIds)];
    this.threshold = threshold;
    this.maxVouchers = maxVouchers;
    this.maxActivePeers = maxActivePeers;
    this.maxAdmissionsPerIssuer = maxAdmissionsPerIssuer;
    this.now = now;
    this.storageHeadroomProvider = storageHeadroomProvider;
  }

  async admit({ subjectNodeId, vouchers } = {}) {
    if (!ID.test(subjectNodeId ?? '') || !Array.isArray(vouchers) ||
      vouchers.length < this.threshold || vouchers.length > this.maxVouchers) {
      return { ok: false, reason: 'invalid-input' };
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, reason: 'admission-state-unavailable' };
    }

    const accepted = new Map();
    for (const voucher of vouchers) {
      if (!voucher || !ID.test(voucher.issuerNodeId ?? '') ||
        !NONCE.test(voucher.nonce ?? '') || accepted.has(voucher.issuerNodeId)) continue;
      const verified = verifyPeerIntroductionVouchers({
        subjectNodeId, vouchers: [voucher],
        trustedIssuerNodeIds: this.trustedIssuerNodeIds,
        threshold: 1, now, maxVouchers: 1,
      });
      if (verified.ok) accepted.set(voucher.issuerNodeId, {
        issuerNodeId: voucher.issuerNodeId, nonce: voucher.nonce,
      });
    }
    if (accepted.size < this.threshold) {
      return { ok: false, reason: 'insufficient-valid-invitations' };
    }

    let storageHeadroomRatio;
    try {
      storageHeadroomRatio = await this.storageHeadroomProvider();
    } catch {
      return { ok: false, reason: 'capacity-unavailable' };
    }
    if (!Number.isFinite(storageHeadroomRatio) ||
      storageHeadroomRatio < 0 || storageHeadroomRatio > 1) {
      return { ok: false, reason: 'capacity-unavailable' };
    }

    const invitations = [...accepted.values()];
    return this.store.commitAdmission({
      subjectNodeId,
      issuerNodeIds: invitations.map(x => x.issuerNodeId),
      invitations,
      storageHeadroomRatio,
      maxActivePeers: this.maxActivePeers,
      maxAdmissionsPerIssuer: this.maxAdmissionsPerIssuer,
    });
  }

  isAdmitted(subjectNodeId) {
    if (typeof this.store.isAdmitted !== 'function') {
      throw new TypeError('Admission store does not support authoritative isAdmitted()');
    }
    return this.store.isAdmitted(subjectNodeId);
  }

  releaseAdmission(subjectNodeId, status = 'released') {
    if (typeof this.store.releaseAdmission !== 'function') {
      throw new TypeError('Admission store does not support releaseAdmission()');
    }
    return this.store.releaseAdmission(subjectNodeId, status);
  }
}
