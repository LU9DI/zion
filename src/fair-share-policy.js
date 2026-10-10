import { mkdir, open, readFile, rename, unlink, lstat, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const NODE_ID = /^[a-f0-9]{64}$/;
const RESERVATION_ID = /^[a-f0-9]{32}$/;

/** Local fair-use gate. Contribution credits must come from locally verified evidence, never peer-supplied numbers. */
export class FairSharePolicy {
  constructor({ maxPersonalBytes = 10 * 1024 ** 3, contributionRatio = 0.5, maxDailyUploadBytes = 20 * 1024 ** 3,
    maxDailyRequests = 10_000, maxConcurrentRequests = 16, maxChunkBytes = 4 * 1024 * 1024,
    contributionTtlMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxPersonalBytes) || maxPersonalBytes < 0 || !Number.isFinite(contributionRatio) || contributionRatio < 0 || contributionRatio > 1 ||
      !Number.isSafeInteger(maxDailyUploadBytes) || maxDailyUploadBytes < 1 || !Number.isSafeInteger(maxDailyRequests) || maxDailyRequests < 1 ||
      !Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 33 ||
      !Number.isSafeInteger(contributionTtlMs) || contributionTtlMs < 1_000 || typeof now !== 'function') {
      throw new TypeError('Invalid fair-share policy configuration');
    }
    this.maxPersonalBytes = maxPersonalBytes; this.contributionRatio = contributionRatio; this.maxDailyUploadBytes = maxDailyUploadBytes;
    this.maxDailyRequests = maxDailyRequests; this.maxConcurrentRequests = maxConcurrentRequests; this.maxChunkBytes = maxChunkBytes;
    this.contributionTtlMs = contributionTtlMs; this.now = now; this.contributionVerifiedAt = null;
    this.contributionBytes = 0; this.day = this.#dayKey(now()); this.dailyBytes = 0; this.dailyRequests = 0; this.reservedBytes = 0; this.activeRequests = 0;
  }
  #dayKey(timestamp) { return Math.floor(timestamp / DAY_MS); }
  #rollDay() {
    const day = this.#dayKey(this.now());
    // Wall-clock rollback must never reset a quota. Advance the accounting day only forward.
    if (day > this.day) { this.day = day; this.dailyBytes = 0; this.dailyRequests = 0; }
  }
  /** Set only from locally verified, current contribution evidence. This is not an RPC. */
  setVerifiedContributionBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Contribution must be a non-negative safe integer');
    this.contributionBytes = bytes;
    this.contributionVerifiedAt = this.now();
    return this.personalQuotaBytes();
  }
  /** Expire point-in-time evidence; a clock rollback fails closed instead of extending credit. */
  contributionEvidenceFresh() {
    if (this.contributionVerifiedAt === null) return false;
    const age = this.now() - this.contributionVerifiedAt;
    return age >= 0 && age <= this.contributionTtlMs;
  }
  revokeVerifiedContribution() { this.contributionBytes = 0; this.contributionVerifiedAt = null; return 0; }
  personalQuotaBytes() {
    if (!this.contributionEvidenceFresh()) return 0;
    return Math.min(this.maxPersonalBytes, Math.floor(this.contributionBytes * this.contributionRatio));
  }
  snapshot({ personalStoredBytes = 0 } = {}) {
    this.#rollDay();
    return Object.freeze({ personalQuotaBytes: this.personalQuotaBytes(), contributionBytes: this.contributionBytes,
      contributionEvidenceFresh: this.contributionEvidenceFresh(), contributionVerifiedAt: this.contributionVerifiedAt, personalStoredBytes,
      dailyUploadBytes: this.dailyBytes, dailyRequests: this.dailyRequests, activeRequests: this.activeRequests, reservedBytes: this.reservedBytes });
  }
  reserve({ ownerId, bytes, personalStoredBytes = 0 } = {}) {
    this.#rollDay();
    if (!NODE_ID.test(ownerId ?? '')) return { ok: false, reason: 'invalid-owner' };
    if (!Number.isSafeInteger(bytes) || bytes < 33 || bytes > this.maxChunkBytes) return { ok: false, reason: 'chunk-size-limit' };
    if (!Number.isSafeInteger(personalStoredBytes) || personalStoredBytes < 0) return { ok: false, reason: 'invalid-storage-accounting' };
    if (this.activeRequests >= this.maxConcurrentRequests) return { ok: false, reason: 'concurrency-limit' };
    if (this.dailyRequests >= this.maxDailyRequests) return { ok: false, reason: 'daily-request-limit' };
    if (this.dailyBytes + this.reservedBytes + bytes > this.maxDailyUploadBytes) return { ok: false, reason: 'daily-upload-limit' };
    const quota = this.personalQuotaBytes();
    if (personalStoredBytes + this.reservedBytes + bytes > quota) return { ok: false, reason: 'personal-quota-exceeded', quotaBytes: quota };
    this.activeRequests++; this.dailyRequests++; this.reservedBytes += bytes;
    let settled = false;
    const settle = (commit) => {
      if (settled) return false;
      settled = true; this.activeRequests--; this.reservedBytes -= bytes;
      if (commit) this.dailyBytes += bytes;
      return true;
    };
    return { ok: true, quotaBytes: quota, reservation: Object.freeze({ bytes, commit: () => settle(true), release: () => settle(false) }) };
  }
}

/** Per-node admission control against a single authenticated identity monopolizing this node. */
export class PeerAbuseGuard {
  constructor({ maxPeers = 10_000, maxDailyBytesPerPeer = 2 * 1024 ** 3, maxDailyRequestsPerPeer = 2_000,
    maxConcurrentPerPeer = 4, now = () => Date.now() } = {}) {
    if (![maxPeers, maxDailyBytesPerPeer, maxDailyRequestsPerPeer, maxConcurrentPerPeer].every(Number.isSafeInteger) ||
      maxPeers < 1 || maxDailyBytesPerPeer < 1 || maxDailyRequestsPerPeer < 1 || maxConcurrentPerPeer < 1 || typeof now !== 'function') throw new TypeError('Invalid peer abuse guard configuration');
    this.maxPeers = maxPeers; this.maxDailyBytesPerPeer = maxDailyBytesPerPeer; this.maxDailyRequestsPerPeer = maxDailyRequestsPerPeer;
    this.maxConcurrentPerPeer = maxConcurrentPerPeer; this.now = now; this.peers = new Map();
  }
  #state(nodeId) {
    if (!NODE_ID.test(nodeId ?? '')) return null;
    const day = Math.floor(this.now() / DAY_MS); let state = this.peers.get(nodeId);
    if (!state) {
      if (this.peers.size >= this.maxPeers) return null;
      state = { day, bytes: 0, requests: 0, active: 0 }; this.peers.set(nodeId, state);
    }
    // A backward clock adjustment must not grant a fresh daily allowance.
    if (day > state.day) { state.day = day; state.bytes = 0; state.requests = 0; }
    return state;
  }
  reserve(nodeId, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) return { ok: false, reason: 'invalid-byte-count' };
    const state = this.#state(nodeId);
    if (!state) return { ok: false, reason: 'peer-capacity-or-identity-limit' };
    if (state.active >= this.maxConcurrentPerPeer) return { ok: false, reason: 'peer-concurrency-limit' };
    if (state.requests >= this.maxDailyRequestsPerPeer) return { ok: false, reason: 'peer-daily-request-limit' };
    if (state.bytes + bytes > this.maxDailyBytesPerPeer) return { ok: false, reason: 'peer-daily-byte-limit' };
    state.active++; state.requests++; let settled = false;
    return { ok: true, commit: () => { if (settled) return false; settled = true; state.active--; state.bytes += bytes; return true; },
      release: () => { if (settled) return false; settled = true; state.active--; return true; } };
  }
}


/**
 * Persistent, cross-process peer admission guard. Daily counters survive restarts;
 * reservations have leases so a crashed process cannot hold capacity forever.
 * The state file is local policy data and must never be accepted from a peer.
 */
export class PersistentPeerAbuseGuard {
  constructor(root, { maxPeers = 10_000, maxDailyBytesPerPeer = 2 * 1024 ** 3,
    maxDailyRequestsPerPeer = 2_000, maxConcurrentPerPeer = 4,
    reservationTtlMs = 60_000, lockWaitMs = 5_000, now = () => Date.now() } = {}) {
    if (typeof root !== 'string' || !root ||
      ![maxPeers, maxDailyBytesPerPeer, maxDailyRequestsPerPeer, maxConcurrentPerPeer, reservationTtlMs, lockWaitMs].every(Number.isSafeInteger) ||
      maxPeers < 1 || maxDailyBytesPerPeer < 1 || maxDailyRequestsPerPeer < 1 || maxConcurrentPerPeer < 1 ||
      reservationTtlMs < 1_000 || lockWaitMs < 100 || typeof now !== 'function') throw new TypeError('Invalid persistent peer abuse guard configuration');
    this.root = path.resolve(root); this.statePath = path.join(this.root, 'peer-abuse-state.json');
    this.lockPath = path.join(this.root, '.peer-abuse-lock'); this.maxPeers = maxPeers;
    this.maxDailyBytesPerPeer = maxDailyBytesPerPeer; this.maxDailyRequestsPerPeer = maxDailyRequestsPerPeer;
    this.maxConcurrentPerPeer = maxConcurrentPerPeer; this.reservationTtlMs = reservationTtlMs;
    this.lockWaitMs = lockWaitMs; this.now = now; this.ready = false; this.localActive = new Set();
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await lstat(this.root);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Peer abuse state root must be a real directory');
    try { await chmod(this.root, 0o700); } catch (e) { if (!['EPERM','ENOTSUP','EINVAL','ENOSYS'].includes(e.code)) throw e; }
    await this.#withLock(async () => { await this.#readState(); });
    this.ready = true; return this;
  }
  async #readState() {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const state = JSON.parse(raw);
      if (state?.schema !== 1 || !state.peers || typeof state.peers !== 'object' || Array.isArray(state.peers)) throw new Error('Invalid peer abuse state schema');
      for (const [id, peer] of Object.entries(state.peers)) {
        if (!NODE_ID.test(id) || !Number.isSafeInteger(peer.day) || !Number.isSafeInteger(peer.bytes) || peer.bytes < 0 ||
          !Number.isSafeInteger(peer.requests) || peer.requests < 0 || !Array.isArray(peer.reservations)) throw new Error('Invalid peer abuse state entry');
        for (const r of peer.reservations) if (!RESERVATION_ID.test(r.id ?? '') || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || !Number.isSafeInteger(r.expiresAt)) throw new Error('Invalid peer abuse reservation');
      }
      return state;
    } catch (e) {
      if (e.code === 'ENOENT') return { schema: 1, peers: {} };
      throw new Error(`Peer abuse state is corrupt; refusing admission: ${e.message}`, { cause: e });
    }
  }
  async #writeState(state) {
    const tmp = path.join(this.root, `.peer-abuse-${randomBytes(12).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    try { await rename(tmp, this.statePath); }
    catch (e) { await unlink(tmp).catch(() => {}); throw e; }
  }
  async #withLock(operation) {
    const started = Date.now(); const token = randomBytes(16).toString('hex');
    while (true) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        const h = await open(path.join(this.lockPath, 'owner.json'), 'wx', 0o600);
        try { await h.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); await h.sync(); } finally { await h.close(); }
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        await this.#reapLockIfSafe();
        if (Date.now() - started >= this.lockWaitMs) { const error = new Error('Peer abuse accounting lock busy; refusing admission'); error.code = 'REA_LOCK_TIMEOUT'; throw error; }
        await new Promise(resolve => setTimeout(resolve, 15 + Math.floor(Math.random() * 25)));
      }
    }
    try { return await operation(); }
    finally {
      try { const owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8')); if (owner.token === token) await rm(this.lockPath, { recursive: true, force: true }); } catch {}
    }
  }
  async #reapLockIfSafe() {
    try {
      const owner = JSON.parse(await readFile(path.join(this.lockPath, 'owner.json'), 'utf8'));
      if (Date.now() - owner.createdAt < 30_000) return;
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
      if (!alive) await rm(this.lockPath, { recursive: true, force: true });
    } catch (e) { if (e.code === 'ENOENT') return; }
  }
  async reserve(nodeId, bytes) {
    if (!this.ready) return { ok: false, reason: 'guard-not-initialized' };
    if (!NODE_ID.test(nodeId ?? '')) return { ok: false, reason: 'invalid-peer-identity' };
    if (!Number.isSafeInteger(bytes) || bytes < 1) return { ok: false, reason: 'invalid-byte-count' };
    const reservationId = randomBytes(16).toString('hex');
    const result = await this.#withLock(async () => {
      const state = await this.#readState(); const now = this.now(); const day = Math.floor(now / DAY_MS);
      // Reclaim only old-day entries with no live reservations. This bounds the
      // persistent identity table without deleting today's anti-abuse history.
      for (const [knownId, known] of Object.entries(state.peers)) {
        known.reservations = known.reservations.filter(r => r.expiresAt > now);
        if (known.day < day && known.reservations.length === 0) delete state.peers[knownId];
      }
      let peer = state.peers[nodeId];
      if (!peer) {
        if (Object.keys(state.peers).length >= this.maxPeers) return { ok: false, reason: 'peer-capacity-or-identity-limit' };
        peer = state.peers[nodeId] = { day, bytes: 0, requests: 0, reservations: [] };
      }
      peer.reservations = peer.reservations.filter(r => r.expiresAt > now);
      // Keep the later accounting day if the system clock moves backward.
      if (day > peer.day) { peer.day = day; peer.bytes = 0; peer.requests = 0; }
      const reservedBytes = peer.reservations.reduce((sum, r) => sum + r.bytes, 0);
      if (peer.reservations.length >= this.maxConcurrentPerPeer) return { ok: false, reason: 'peer-concurrency-limit' };
      if (peer.requests >= this.maxDailyRequestsPerPeer) return { ok: false, reason: 'peer-daily-request-limit' };
      if (peer.bytes + reservedBytes + bytes > this.maxDailyBytesPerPeer) return { ok: false, reason: 'peer-daily-byte-limit' };
      peer.requests++;
      peer.reservations.push({ id: reservationId, bytes, expiresAt: now + this.reservationTtlMs });
      await this.#writeState(state);
      return { ok: true };
    });
    if (!result.ok) return result;
    this.localActive.add(reservationId);
    let settled = false;
    const settle = async commit => {
      if (settled) return false; settled = true; this.localActive.delete(reservationId);
      await this.#withLock(async () => {
        const state = await this.#readState(); const peer = state.peers[nodeId]; if (!peer) return;
        const idx = peer.reservations.findIndex(r => r.id === reservationId);
        if (idx < 0) return; const [reservation] = peer.reservations.splice(idx, 1);
        if (commit) peer.bytes += reservation.bytes;
        await this.#writeState(state);
      });
      return true;
    };
    return { ok: true, commit: () => settle(true), release: () => settle(false) };
  }
}
