import { verifyPeerIntroductionVouchers } from './peer-introduction-vouchers.js';

const ID = /^[a-f0-9]{64}$/;
const CONSUMED_INVITATION = /^[a-f0-9]{64}:[a-f0-9]{32}$/;
const MAX_RECORDS = 100_000;

function validState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.consumed) ||
    !Array.isArray(state.admissions) || state.consumed.length > MAX_RECORDS ||
    state.admissions.length > MAX_RECORDS ||
    !state.consumed.every(x => typeof x === 'string' && CONSUMED_INVITATION.test(x)) ||
    new Set(state.consumed).size !== state.consumed.length ||
    !state.admissions.every(x => x && ID.test(x.subjectNodeId ?? '') &&
      Array.isArray(x.issuerNodeIds) && x.issuerNodeIds.length > 0 &&
      x.issuerNodeIds.every(id => ID.test(id)) &&
      new Set(x.issuerNodeIds).size === x.issuerNodeIds.length)) return false;
  return new Set(state.admissions.map(x => x.subjectNodeId)).size === state.admissions.length;
}
const emptyState = () => ({ version: 1, consumed: [], admissions: [] });

/**
 * Invite-only admission policy. Supply a durable stateStore with synchronous load() and
 * synchronous or asynchronous save() methods, plus a live capacityProvider. This is a single-process coordinator, not a DHT consensus
 * mechanism; multi-process deployments need a transactional shared store with uniqueness constraints.
 */
export class PeerAdmissionController {
  constructor({
    trustedIssuerNodeIds, threshold = 2, maxActivePeers = 100,
    maxAdmissionsPerIssuer = 5, minStorageHeadroomRatio = 0.1,
    maxVouchers = 16, now = () => Date.now(), capacityProvider,
    stateStore, maxRecords = MAX_RECORDS, rolloutPolicy = null,
  } = {}) {
    if (stateStore && stateStore.load?.constructor?.name === 'AsyncFunction') {
      throw Object.assign(new TypeError('Peer admission stateStore.load() must be synchronous'), { code: 'ZION_ADMISSION_ASYNC_STORE_UNSUPPORTED' });
    }
    if (!Array.isArray(trustedIssuerNodeIds) || trustedIssuerNodeIds.some(id => !ID.test(id)) ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > 16 ||
      !Number.isSafeInteger(maxActivePeers) || maxActivePeers < 1 ||
      !Number.isSafeInteger(maxAdmissionsPerIssuer) || maxAdmissionsPerIssuer < 1 ||
      !Number.isFinite(minStorageHeadroomRatio) || minStorageHeadroomRatio < 0 || minStorageHeadroomRatio > 1 ||
      !Number.isSafeInteger(maxVouchers) || maxVouchers < threshold || maxVouchers > 64 ||
      typeof now !== 'function' || typeof capacityProvider !== 'function' ||
      (rolloutPolicy !== null && typeof rolloutPolicy.evaluate !== 'function') ||
      !stateStore || typeof stateStore.load !== 'function' || typeof stateStore.save !== 'function' ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) {
      throw new TypeError('Invalid peer admission configuration');
    }
    this.trusted = [...new Set(trustedIssuerNodeIds)];
    this.threshold = threshold;
    this.maxActivePeers = maxActivePeers;
    this.maxAdmissionsPerIssuer = maxAdmissionsPerIssuer;
    this.minStorageHeadroomRatio = minStorageHeadroomRatio;
    this.maxVouchers = maxVouchers;
    this.now = now;
    this.capacityProvider = capacityProvider;
    this.rolloutPolicy = rolloutPolicy;
    this.stateStore = stateStore;
    this.maxRecords = maxRecords;
    const loaded = stateStore.load();
    if (loaded && typeof loaded.then === 'function') {
      throw Object.assign(new TypeError('Peer admission stateStore.load() must be synchronous'), { code: 'ZION_ADMISSION_ASYNC_STORE_UNSUPPORTED' });
    }
    if (loaded === null || loaded === undefined) this.state = emptyState();
    else if (validState(loaded)) this.state = {
      version: 1, consumed: [...loaded.consumed],
      admissions: loaded.admissions.map(x => ({ subjectNodeId: x.subjectNodeId, issuerNodeIds: [...x.issuerNodeIds] })),
    };
    else throw Object.assign(new Error('Peer admission state is invalid'), { code: 'ZION_ADMISSION_STATE_CORRUPT' });
    this.queue = Promise.resolve();
    this.persistenceFailed = false;
  }

  admit({ subjectNodeId, vouchers } = {}) {
    const operation = this.queue.then(() => this.#admit({ subjectNodeId, vouchers }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async #admit({ subjectNodeId, vouchers }) {
    // A failed save may have committed on disk before reporting an error (for example,
    // directory fsync failure after rename). Without a transactional read-back contract,
    // continuing from the old in-memory snapshot could reuse vouchers or exceed quotas.
    if (this.persistenceFailed) return { ok: false, reason: 'admission-state-unavailable' };
    if (!ID.test(subjectNodeId ?? '') || !Array.isArray(vouchers) ||
      vouchers.length < this.threshold || vouchers.length > this.maxVouchers) {
      return { ok: false, reason: 'invalid-input' };
    }
    if (this.state.admissions.some(x => x.subjectNodeId === subjectNodeId)) {
      return { ok: false, reason: 'subject-already-admitted' };
    }
    const capacity = await this.capacityProvider();
    if (!capacity || !Number.isSafeInteger(capacity.activePeers) || capacity.activePeers < 0 ||
      !Number.isSafeInteger(capacity.maxPeers) || capacity.maxPeers < 1 ||
      !Number.isFinite(capacity.storageHeadroomRatio) || capacity.storageHeadroomRatio < 0 ||
      capacity.storageHeadroomRatio > 1) return { ok: false, reason: 'capacity-unavailable' };
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
      if (!check.ok) continue;
      const key = `${voucher.issuerNodeId}:${voucher.nonce}`;
      if (accepted.has(voucher.issuerNodeId) || accepted.size >= this.maxVouchers) continue;
      accepted.set(voucher.issuerNodeId, { key, issuerNodeId: voucher.issuerNodeId });
    }
    if (accepted.size < this.threshold) return { ok: false, reason: 'insufficient-valid-invitations' };
    for (const item of accepted.values()) {
      if (this.state.consumed.includes(item.key)) return { ok: false, reason: 'invitation-already-used' };
      const count = this.state.admissions.reduce((n, record) =>
        n + Number(record.issuerNodeIds.includes(item.issuerNodeId)), 0);
      if (count >= this.maxAdmissionsPerIssuer) return { ok: false, reason: 'issuer-admission-quota-reached' };
    }
    if (this.state.consumed.length + accepted.size > this.maxRecords ||
      this.state.admissions.length >= this.maxRecords) return { ok: false, reason: 'admission-state-capacity-reached' };

    const next = {
      version: 1,
      consumed: [...this.state.consumed, ...[...accepted.values()].map(x => x.key)],
      admissions: [...this.state.admissions, {
        subjectNodeId, issuerNodeIds: [...accepted.keys()],
      }],
    };
    // Persist before reporting success; async save implementations must be awaited so a
    // transport never accepts the peer before persistence has completed. The controller's
    // local queue serializes this process only; shared stores still need real transactions.
    try {
      await this.stateStore.save(next);
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    }
    this.state = next;
    return { ok: true, subjectNodeId, trustedIntroductions: accepted.size,
      issuerNodeIds: [...accepted.keys()] };
  }

  releaseAdmission(subjectNodeId, status = 'released') {
    const operation = this.queue.then(async () => {
      if (this.persistenceFailed) return { ok: false, reason: 'admission-state-unavailable' };
      if (!ID.test(subjectNodeId ?? '') || typeof status !== 'string' || status.length < 1 || status.length > 64) {
        return { ok: false, reason: 'invalid-input' };
      }
      const existing = this.state.admissions.find(record => record.subjectNodeId === subjectNodeId);
      if (!existing) return { ok: true, released: false, subjectNodeId };
      // Keep consumed invitation nonces permanently consumed even after revocation.
      const next = {
        version: 1,
        consumed: [...this.state.consumed],
        admissions: this.state.admissions.filter(record => record.subjectNodeId !== subjectNodeId),
      };
      try {
        await this.stateStore.save(next);
      } catch (error) {
        // The save may have reached durable storage despite reporting failure. Stop
        // subsequent writes and reads from authorizing peers until restart/reconciliation.
        this.persistenceFailed = true;
        throw error;
      }
      this.state = next;
      return { ok: true, released: true, subjectNodeId, status };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  isAdmitted(subjectNodeId) {
    return !this.persistenceFailed && ID.test(subjectNodeId ?? '') &&
      this.state.admissions.some(record => record.subjectNodeId === subjectNodeId);
  }

  snapshot() {
    return Object.freeze({
      consumedInvitations: this.state.consumed.length,
      admittedPeers: this.state.admissions.length,
    });
  }
}
