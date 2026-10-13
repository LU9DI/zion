import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_RECORDS = 5000;
const MAX_MESSAGE = 1000;
const MAX_EVENT_KEY = 180;
const TYPES = new Set(['pause-warning', 'contribution-paused', 'capacity-reduction-warning', 'capacity-reduction-pending', 'capacity-reduced']);
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function syncDirectoryEntry(directory) {
  // Node.js cannot portably fsync directory handles on Windows (EPERM).
  // Individual state/backup files are fsynced before publication; directory-entry durability is weaker on Windows.
  if (process.platform === 'win32') return;
  const dirFd = openSync(directory, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

function cleanText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${label}`);
  return value.trim();
}

/** Durable owner-scoped notification outbox. Delivery is only confirmed by an adapter receipt. */
export class InactivityNotificationStore {
  /**
   * Read-only recovery assessment. It never restores, rewrites, or removes files.
   * The result deliberately exposes hashes and record IDs, not notification bodies.
   */
  static inspectRecovery({ statePath, maxRecords = MAX_RECORDS } = {}) {
    if (typeof statePath !== 'string' || !statePath.trim() || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) {
      throw new TypeError('Invalid notification recovery inspection configuration');
    }
    const canonicalPath = resolve(statePath);
    const backupPath = `${canonicalPath}.last-good`;
    // Construct a branded instance so the private schema validator can be reused.
    // The probe path is intentionally unique and is never written by inspection.
    const validator = new InactivityNotificationStore({
      statePath: `${canonicalPath}.inspection-${randomUUID()}`, maxRecords,
    });
    validator.statePath = canonicalPath;

    const inspectFile = path => {
      let stat;
      try { stat = lstatSync(path); }
      catch (error) {
        if (error?.code === 'ENOENT') return { exists: false, valid: false, errorCode: 'NOT_FOUND' };
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { exists: true, valid: false, errorCode: 'NOTIFICATION_RECOVERY_UNSAFE_FILE_TYPE' };
      }
      const raw = readFileSync(path, 'utf8');
      const sha256 = createHash('sha256').update(raw).digest('hex');
      try {
        const parsed = validator.#validatePersistedState(raw);
        return { exists: true, valid: true, sha256, recordCount: parsed.notifications.length,
          notificationIds: parsed.notifications.map(item => item.id) };
      } catch (error) {
        return { exists: true, valid: false, sha256, errorCode: error?.code || 'NOTIFICATION_RECOVERY_VALIDATION_FAILED' };
      }
    };

    const canonical = inspectFile(canonicalPath);
    const lastGood = inspectFile(backupPath);
    const ids = item => new Set(item.valid ? item.notificationIds : []);
    const canonicalIds = ids(canonical);
    const backupIds = ids(lastGood);
    const difference = canonical.valid && lastGood.valid ? {
      canonicalOnlyIds: [...canonicalIds].filter(id => !backupIds.has(id)),
      lastGoodOnlyIds: [...backupIds].filter(id => !canonicalIds.has(id)),
      canonicalOnlyCount: [...canonicalIds].filter(id => !backupIds.has(id)).length,
      lastGoodOnlyCount: [...backupIds].filter(id => !canonicalIds.has(id)).length,
    } : null;
    return Object.freeze({
      status: canonical.valid ? (lastGood.valid ? 'both-valid' : 'canonical-only-valid')
        : (lastGood.valid ? 'last-good-only-valid' : 'no-valid-snapshot'),
      canonical: Object.freeze({ exists: canonical.exists, valid: canonical.valid,
        ...(canonical.sha256 ? { sha256: canonical.sha256 } : {}),
        ...(canonical.recordCount !== undefined ? { recordCount: canonical.recordCount } : {}),
        ...(canonical.errorCode ? { errorCode: canonical.errorCode } : {}) }),
      lastGood: Object.freeze({ exists: lastGood.exists, valid: lastGood.valid,
        ...(lastGood.sha256 ? { sha256: lastGood.sha256 } : {}),
        ...(lastGood.recordCount !== undefined ? { recordCount: lastGood.recordCount } : {}),
        ...(lastGood.errorCode ? { errorCode: lastGood.errorCode } : {}) }),
      difference: difference ? Object.freeze(difference) : null,
      automaticRestorePerformed: false,
    });
  }

  /**
   * Explicit, optimistic-concurrency-checked recovery from the validated last-good snapshot.
   * Refuses to replace a valid canonical state and preserves corrupt bytes before replacement.
   */
  static async recoverLastGood({ statePath, confirmRestore = false, expectedCanonicalSha256, expectedLastGoodSha256,
    maxRecords = MAX_RECORDS, lockTimeoutMs = 10_000, staleLockMs = 30_000, syncDirectory = syncDirectoryEntry } = {}) {
    if (typeof statePath !== 'string' || !statePath.trim() || confirmRestore !== true ||
      !(expectedCanonicalSha256 === null || (typeof expectedCanonicalSha256 === 'string' && /^[a-f0-9]{64}$/i.test(expectedCanonicalSha256))) ||
      typeof expectedLastGoodSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedLastGoodSha256)) {
      throw Object.assign(new Error('Explicit confirmation and current inspection hashes are required for recovery'), {
        code: 'NOTIFICATION_RECOVERY_CONFIRMATION_REQUIRED',
      });
    }
    const canonicalPath = resolve(statePath);
    const probe = new InactivityNotificationStore({ statePath: `${canonicalPath}.recovery-probe-${randomUUID()}`,
      maxRecords, lockTimeoutMs, staleLockMs, syncDirectory });
    probe.statePath = canonicalPath;
    probe.lockPath = `${canonicalPath}.lock`;
    return probe.#withRecoveryLock(async () => {
      const backupPath = `${canonicalPath}.last-good`;
      const inspectRaw = path => {
        let stat;
        try { stat = lstatSync(path); }
        catch (error) { if (error?.code === 'ENOENT') return { exists: false, raw: null, sha256: null }; throw error; }
        if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('Recovery only accepts regular, non-symlink files'), {
          code: 'NOTIFICATION_RECOVERY_UNSAFE_FILE_TYPE',
        });
        const raw = readFileSync(path, 'utf8');
        return { exists: true, raw, sha256: createHash('sha256').update(raw).digest('hex') };
      };
      const canonical = inspectRaw(canonicalPath);
      const backup = inspectRaw(backupPath);
      if (canonical.sha256 !== expectedCanonicalSha256 || backup.sha256 !== expectedLastGoodSha256) {
        throw Object.assign(new Error('Recovery files changed since inspection; inspect again before retrying'), {
          code: 'NOTIFICATION_RECOVERY_STALE_INSPECTION',
        });
      }
      if (!backup.exists) throw Object.assign(new Error('Last-good recovery snapshot does not exist'), { code: 'NOTIFICATION_RECOVERY_SNAPSHOT_MISSING' });
      let validatedBackup;
      try { validatedBackup = probe.#validatePersistedState(backup.raw); }
      catch (cause) { throw Object.assign(new Error('Last-good snapshot failed schema validation; canonical state was not changed', { cause }), {
        code: 'NOTIFICATION_RECOVERY_SNAPSHOT_INVALID',
      }); }
      if (canonical.exists) {
        try {
          probe.#validatePersistedState(canonical.raw);
          throw Object.assign(new Error('Refusing to overwrite a valid canonical notification state'), {
            code: 'NOTIFICATION_RECOVERY_CANONICAL_VALID',
          });
        } catch (error) {
          if (error?.code === 'NOTIFICATION_RECOVERY_CANONICAL_VALID') throw error;
          // Invalid canonical bytes must be preserved exactly before recovery.
        }
      }
      let preservedPath = null;
      const directory = dirname(canonicalPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (canonical.exists) {
        preservedPath = `${canonicalPath}.corrupt-${Date.now()}-${randomUUID()}`;
        let preserveFd;
        try {
          preserveFd = openSync(preservedPath, 'wx', 0o600);
          writeFileSync(preserveFd, canonical.raw, 'utf8');
          fsyncSync(preserveFd);
          closeSync(preserveFd);
          preserveFd = undefined;
          syncDirectory(directory);
        } catch (error) {
          if (preserveFd !== undefined) { try { closeSync(preserveFd); } catch {} }
          try { unlinkSync(preservedPath); } catch {}
          throw Object.assign(new Error('Could not preserve corrupt canonical state; recovery aborted', { cause: error }), {
            code: 'NOTIFICATION_RECOVERY_PRESERVATION_FAILED', commitVisible: false,
          });
        }
      }
      const temp = `${canonicalPath}.${randomUUID()}.tmp`;
      let fd;
      try {
        fd = openSync(temp, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify(validatedBackup)}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, canonicalPath);
        try { syncDirectory(directory); }
        catch (cause) { throw Object.assign(new Error('Recovery file is visible but directory durability could not be confirmed', { cause }), {
          code: 'NOTIFICATION_RECOVERY_DURABILITY_UNCONFIRMED', commitVisible: true,
        }); }
      } catch (error) {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        try { unlinkSync(temp); } catch {}
        throw error;
      }
      const restoredRaw = readFileSync(canonicalPath, 'utf8');
      probe.#validatePersistedState(restoredRaw);
      const restoredSha256 = createHash('sha256').update(restoredRaw).digest('hex');
      const audit = Object.freeze({ schemaVersion: 1, operation: 'notification-store-recovery', status: 'restored',
        confirmed: true, source: 'last-good', canonicalPath, previousCanonicalSha256: expectedCanonicalSha256,
        sourceSnapshotSha256: expectedLastGoodSha256, restoredSha256,
        restoredRecordCount: validatedBackup.notifications.length, preservedCorruptPath: preservedPath,
        automaticRestorePerformed: false, restoredAt: nowIso() });
      const auditPath = `${canonicalPath}.recovery-audit-${Date.now()}-${randomUUID()}.json`;
      let auditFd;
      try {
        auditFd = openSync(auditPath, 'wx', 0o600);
        writeFileSync(auditFd, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
        fsyncSync(auditFd);
        closeSync(auditFd);
        auditFd = undefined;
        syncDirectory(directory);
      } catch (cause) {
        if (auditFd !== undefined) { try { closeSync(auditFd); } catch {} }
        throw Object.assign(new Error('Recovery is visible and verified, but the durable audit record could not be confirmed', { cause }), {
          code: 'NOTIFICATION_RECOVERY_AUDIT_UNCONFIRMED', commitVisible: true, restoredSha256,
          preservedCorruptPath: preservedPath, auditPath,
        });
      }
      return Object.freeze({ status: 'restored', restoredSha256,
        restoredRecordCount: validatedBackup.notifications.length, preservedCorruptPath: preservedPath,
        auditPath, source: 'last-good', automaticRestorePerformed: false, audit });
    });
  }

  constructor({ statePath, now = nowIso, maxRecords = MAX_RECORDS, lockTimeoutMs = 10_000, staleLockMs = 30_000, syncDirectory = syncDirectoryEntry } = {}) {
    if (typeof statePath !== 'string' || !statePath.trim() || typeof now !== 'function' || typeof syncDirectory !== 'function' || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 100 || lockTimeoutMs > 120_000 || !Number.isSafeInteger(staleLockMs) || staleLockMs < 1_000 || staleLockMs > 24 * 60 * 60 * 1000) {
      throw new TypeError('Invalid inactivity notification store configuration');
    }
    this.statePath = resolve(statePath);
    this.now = now;
    this.maxRecords = maxRecords;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
    this.syncDirectory = syncDirectory;
    this.lockPath = `${this.statePath}.lock`;
    this.queue = Promise.resolve();
    this.state = this.#load();
    this.persistedStateSnapshot = structuredClone(this.state);
  }

  async #withRecoveryLock(operation) {
    const next = this.queue.then(async () => {
      const release = await this.#acquireFileLock();
      try { return await operation(); } finally { release(); }
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async #exclusive(operation) {
    const next = this.queue.then(async () => {
      const release = await this.#acquireFileLock();
      try {
        // Validate/reload the canonical snapshot before cleanup. If it is corrupt,
        // preserve temp files as forensic/recovery evidence rather than deleting them.
        this.state = this.#load();
        this.persistedStateSnapshot = structuredClone(this.state);
        // A previous process may have died before renaming its temp snapshot.
        // Clean only exact store-generated UUID temp names after canonical validation.
        this.#cleanupAbandonedTempFiles();
        return await operation();
      } finally {
        release();
      }
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async #acquireFileLock() {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    const token = randomUUID();
    while (Date.now() - startedAt <= this.lockTimeoutMs) {
      let fd;
      try {
        fd = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        return () => {
          try {
            const current = JSON.parse(readFileSync(this.lockPath, 'utf8'));
            if (current?.token === token && current?.pid === process.pid) unlinkSync(this.lockPath);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        if (fd !== undefined) { try { closeSync(fd); } catch {} }
        if (error?.code !== 'EEXIST') throw error;
        this.#removeStaleLockIfSafe();
        await sleep(10 + Math.floor(Math.random() * 20));
      }
    }
    throw Object.assign(new Error('Timed out waiting for notification outbox file lock'), { code: 'NOTIFICATION_STORE_LOCK_TIMEOUT' });
  }

  #cleanupAbandonedTempFiles() {
    const directory = dirname(this.statePath);
    const prefix = `${basename(this.statePath)}.`;
    const suffixPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix)) continue;
      const tail = name.slice(prefix.length);
      const backupTempPattern = /^last-good\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
      if (!suffixPattern.test(tail) && !backupTempPattern.test(tail)) continue;
      const candidate = join(directory, `${prefix}${tail}`);
      let stat;
      try { stat = lstatSync(candidate); }
      catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
      // Never recurse into directories or follow symlinks during crash cleanup.
      if (stat.isFile() || stat.isSymbolicLink()) {
        try { unlinkSync(candidate); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
  }

  #removeStaleLockIfSafe() {
    let stat;
    try { stat = lstatSync(this.lockPath); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Notification lock must be a regular non-symlink file');
    let lock;
    try { lock = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch { lock = null; }
    if (lock && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
      try { process.kill(lock.pid, 0); return; }
      catch (error) {
        if (error?.code !== 'ESRCH') return; // EPERM means the process may still be alive.
      }
      try {
        const current = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        if (current?.pid === lock.pid && current?.token === lock.token) unlinkSync(this.lockPath);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return;
    }
    // An incomplete lock write is recoverable only after the full stale window.
    if (Date.now() - stat.mtimeMs > this.staleLockMs) {
      try { unlinkSync(this.lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }

  enqueue({ ownerIdentityId, event, eventKey = null } = {}) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    if (!event || typeof event !== 'object' || !TYPES.has(event.type)) throw new TypeError('Invalid inactivity notification event');
    const type = event.type;
    const message = cleanText(event.message, MAX_MESSAGE, 'notification message');
    const key = eventKey === null ? null : cleanText(eventKey, MAX_EVENT_KEY, 'notification event key');
    return this.#exclusive(async () => {
      if (key) {
        const existing = this.state.notifications.find(item => item.ownerIdentityId === owner && item.eventKey === key);
        if (existing) return Object.freeze({ created: false, notification: Object.freeze({ ...existing }) });
      }
      if (this.state.notifications.length >= this.maxRecords) {
        // Evict only old delivered records; pending notifications are never silently dropped.
        const removable = this.state.notifications.findIndex(item => item.deliveryStatus === 'delivered');
        if (removable < 0) throw Object.assign(new Error('Notification outbox is full; pending notifications were preserved'), { code: 'NOTIFICATION_OUTBOX_FULL' });
        this.state.notifications.splice(removable, 1);
      }
      const record = {
        id: randomUUID(), ownerIdentityId: owner, type, message,
        createdAt: cleanText(this.now(), 64, 'timestamp'), eventKey: key,
        metadata: this.#safeMetadata(event), deliveryStatus: 'pending', attempts: 0,
        lastAttemptAt: null, deliveredAt: null, deliveryReceipt: null, viewedAt: null,
      };
      this.state.notifications.push(record);
      this.#save();
      return Object.freeze({ created: true, notification: Object.freeze({ ...record }) });
    });
  }

  list(ownerIdentityId, { status = 'all', limit = 100 } = {}) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    if (!['all', 'pending', 'delivered', 'ambiguous'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('Invalid notification list options');
    return this.#exclusive(async () => Object.freeze(this.state.notifications
      .filter(item => item.ownerIdentityId === owner && (status === 'all' || item.deliveryStatus === status))
      .slice(-limit).reverse().map(item => Object.freeze({ ...item }))));
  }

  claimDelivery(ownerIdentityId, notificationId, { leaseMs = 120_000 } = {}) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60 * 1000) throw new TypeError('Invalid delivery lease duration');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (record.deliveryStatus === 'delivered') return null;
      const nowMs = Date.parse(this.now());
      const leaseUntilMs = Date.parse(record.deliveryLeaseUntil ?? '');
      if (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) return null;
      // A process that died after persisting dispatch intent may have reached the provider.
      // Never blindly resend it: convert the expired in-flight attempt to ambiguous.
      if (record.deliveryStatus === 'pending' && record.deliveryStartedAt !== undefined) {
        record.deliveryStatus = 'ambiguous';
        record.deliveryAmbiguousAt = cleanText(this.now(), 64, 'timestamp');
        record.deliveryAmbiguityReason = 'worker-crash-during-delivery';
        delete record.deliveryStartedAt;
        delete record.deliveryClaimToken;
        delete record.deliveryLeaseUntil;
        this.#save();
        return null;
      }
      const claimToken = randomUUID();
      record.deliveryClaimToken = claimToken;
      record.deliveryLeaseUntil = new Date(nowMs + leaseMs).toISOString();
      this.#save();
      return Object.freeze({ claimToken, leaseUntil: record.deliveryLeaseUntil, id: record.id });
    });
  }

  markDeliveryStarted(ownerIdentityId, notificationId, claimToken) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    const token = cleanText(claimToken, 64, 'delivery claim token');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (record.deliveryClaimToken !== token) throw new Error('Delivery claim is no longer valid');
      if (record.deliveryStatus !== 'pending') throw new Error('Notification is not pending delivery');
      record.deliveryStartedAt = cleanText(this.now(), 64, 'timestamp');
      this.#save();
      return Object.freeze({ ...record });
    });
  }

  markDeliveryAmbiguous(ownerIdentityId, notificationId, claimToken, reason = 'provider-outcome-unknown') {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    const token = cleanText(claimToken, 64, 'delivery claim token');
    const safeReason = cleanText(reason, 120, 'ambiguity reason').replace(/[^a-zA-Z0-9._:-]/gu, '-');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (record.deliveryClaimToken !== token) throw new Error('Delivery claim is no longer valid');
      if (record.deliveryStatus === 'delivered') return Object.freeze({ ...record });
      record.deliveryStatus = 'ambiguous';
      record.deliveryAmbiguousAt = cleanText(this.now(), 64, 'timestamp');
      record.deliveryAmbiguityReason = safeReason;
      delete record.deliveryClaimToken;
      delete record.deliveryLeaseUntil;
      delete record.deliveryStartedAt;
      this.#save();
      return Object.freeze({ ...record });
    });
  }

  resolveDeliveryAmbiguity(ownerIdentityId, notificationId, claimToken, outcome, receipt = null) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    const token = cleanText(claimToken, 64, 'delivery claim token');
    if (!['delivered', 'not-delivered', 'unknown'].includes(outcome)) throw new TypeError('Invalid ambiguity resolution outcome');
    const safeReceipt = outcome === 'delivered' ? cleanText(receipt, 256, 'provider delivery receipt') : null;
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (record.deliveryClaimToken !== token) throw new Error('Delivery claim is no longer valid');
      if (record.deliveryStatus !== 'ambiguous') throw new Error('Notification is not awaiting reconciliation');
      if (outcome === 'delivered') {
        record.deliveryStatus = 'delivered';
        record.deliveryReceipt = safeReceipt;
        record.deliveredAt = cleanText(this.now(), 64, 'timestamp');
        delete record.deliveryAmbiguousAt;
        delete record.deliveryAmbiguityReason;
      } else if (outcome === 'not-delivered') {
        record.deliveryStatus = 'pending';
        record.lastAttemptAt = cleanText(this.now(), 64, 'timestamp');
        delete record.deliveryAmbiguousAt;
        delete record.deliveryAmbiguityReason;
      } else {
        record.deliveryAmbiguousAt = cleanText(this.now(), 64, 'timestamp');
      }
      delete record.deliveryClaimToken;
      delete record.deliveryLeaseUntil;
      this.#save();
      return Object.freeze({ ...record });
    });
  }

  releaseDeliveryClaim(ownerIdentityId, notificationId, claimToken) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    const token = cleanText(claimToken, 64, 'delivery claim token');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (record.deliveryClaimToken !== token) return false;
      delete record.deliveryClaimToken;
      delete record.deliveryLeaseUntil;
      delete record.deliveryStartedAt;
      this.#save();
      return true;
    });
  }

  recordAttempt(ownerIdentityId, notificationId, claimToken = null) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (claimToken !== null && record.deliveryClaimToken !== claimToken) throw new Error('Delivery claim is no longer valid');
      if (record.deliveryStatus === 'delivered') return Object.freeze({ ...record });
      record.attempts += 1;
      record.lastAttemptAt = cleanText(this.now(), 64, 'timestamp');
      this.#save();
      return Object.freeze({ ...record });
    });
  }

  confirmDelivered(ownerIdentityId, notificationId, providerReceipt, claimToken = null) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    const receipt = cleanText(providerReceipt, 256, 'provider delivery receipt');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (claimToken !== null && record.deliveryClaimToken !== claimToken) throw new Error('Delivery claim is no longer valid');
      if (record.deliveryStatus === 'delivered') {
        if (record.deliveryReceipt !== receipt) throw new Error('Conflicting delivery receipt for an already delivered notification');
        return Object.freeze({ ...record });
      }
      record.deliveryStatus = 'delivered';
      record.deliveredAt = cleanText(this.now(), 64, 'timestamp');
      record.deliveryReceipt = receipt;
      delete record.deliveryClaimToken;
      delete record.deliveryLeaseUntil;
      delete record.deliveryStartedAt;
      this.#save();
      return Object.freeze({ ...record });
    });
  }

  markViewed(ownerIdentityId, notificationId) {
    const owner = cleanText(ownerIdentityId, 256, 'owner identity');
    const id = cleanText(notificationId, 64, 'notification ID');
    return this.#exclusive(async () => {
      const record = this.#findOwned(owner, id);
      if (!record.viewedAt) { record.viewedAt = cleanText(this.now(), 64, 'timestamp'); this.#save(); }
      return Object.freeze({ ...record });
    });
  }

  #findOwned(owner, id) {
    const record = this.state.notifications.find(item => item.id === id && item.ownerIdentityId === owner);
    if (!record) throw Object.assign(new Error('Notification not found for authenticated owner'), { code: 'NOTIFICATION_NOT_FOUND' });
    return record;
  }

  #safeMetadata(event) {
    const allowed = ['deadlineAt', 'idleMs', 'targetBytes', 'usedBytes', 'previousCapacityBytes', 'capacityBytes'];
    return Object.fromEntries(allowed.filter(key => Number.isSafeInteger(event[key]) && event[key] >= 0).map(key => [key, event[key]]));
  }

  #load() {
    let stat;
    try { stat = lstatSync(this.statePath); }
    catch (error) { if (error?.code === 'ENOENT') return { version: 1, notifications: [] }; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Notification state must be a regular non-symlink file');
    return this.#validatePersistedState(readFileSync(this.statePath, 'utf8'));
  }

  #validateStateObject(value) {
    if (value?.version !== 1 || !Array.isArray(value.notifications) || value.notifications.length > this.maxRecords) {
      throw Object.assign(new Error('Invalid persisted notification state; original file was preserved'), {
        code: 'NOTIFICATION_STORE_INVALID_STATE', statePath: this.statePath,
      });
    }
    const seenIds = new Set();
    const seenOwnerEventKeys = new Set();
    for (const item of value.notifications) {
      if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 64 ||
        typeof item.ownerIdentityId !== 'string' || !item.ownerIdentityId.trim() || item.ownerIdentityId.length > 256 ||
        !TYPES.has(item.type) || typeof item.message !== 'string' || !item.message.trim() || item.message.length > MAX_MESSAGE ||
        !['pending', 'delivered', 'ambiguous'].includes(item.deliveryStatus) || !Number.isSafeInteger(item.attempts) || item.attempts < 0 ||
        !item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata) ||
        typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) ||
        (item.eventKey !== null && item.eventKey !== undefined && (typeof item.eventKey !== 'string' || item.eventKey.length > MAX_EVENT_KEY)) ||
        (item.deliveryStatus === 'delivered' && (typeof item.deliveryReceipt !== 'string' || !item.deliveryReceipt.trim() ||
          typeof item.deliveredAt !== 'string' || !Number.isFinite(Date.parse(item.deliveredAt)))) ||
        (item.deliveryStatus === 'pending' && item.deliveredAt !== null && item.deliveredAt !== undefined) ||
        (item.deliveryStartedAt !== undefined && (item.deliveryStatus !== 'pending' || typeof item.deliveryStartedAt !== 'string' || !Number.isFinite(Date.parse(item.deliveryStartedAt)))) ||
        (item.deliveryStatus !== 'pending' && item.deliveryStartedAt !== undefined) ||
        ((item.deliveryClaimToken === undefined) !== (item.deliveryLeaseUntil === undefined)) ||
        (item.deliveryClaimToken !== undefined && (typeof item.deliveryClaimToken !== 'string' || !item.deliveryClaimToken.trim() ||
          item.deliveryClaimToken.length > 128 || typeof item.deliveryLeaseUntil !== 'string' || !Number.isFinite(Date.parse(item.deliveryLeaseUntil)))) ||
        (item.deliveryStatus === 'delivered' && item.deliveryClaimToken !== undefined) ||
        (item.deliveryStatus === 'ambiguous' && (typeof item.deliveryAmbiguousAt !== 'string' || !Number.isFinite(Date.parse(item.deliveryAmbiguousAt)) || typeof item.deliveryAmbiguityReason !== 'string' || !item.deliveryAmbiguityReason.trim())) ||
        (item.deliveryStatus !== 'ambiguous' && (item.deliveryAmbiguousAt !== undefined || item.deliveryAmbiguityReason !== undefined))) {
        throw Object.assign(new Error('Invalid persisted notification record; original file was preserved'), {
          code: 'NOTIFICATION_STORE_INVALID_RECORD', statePath: this.statePath,
        });
      }
      if (seenIds.has(item.id)) throw Object.assign(new Error('Duplicate notification ID in persisted state; original file was preserved'), {
        code: 'NOTIFICATION_STORE_DUPLICATE_ID', statePath: this.statePath,
      });
      seenIds.add(item.id);
      if (typeof item.eventKey === 'string' && item.eventKey.length > 0) {
        const ownerEventKey = `${item.ownerIdentityId}\u0000${item.eventKey}`;
        if (seenOwnerEventKeys.has(ownerEventKey)) throw Object.assign(new Error('Duplicate owner-scoped event key in persisted state; original file was preserved'), {
          code: 'NOTIFICATION_STORE_DUPLICATE_EVENT_KEY', statePath: this.statePath,
        });
        seenOwnerEventKeys.add(ownerEventKey);
      }
    }
    return value;
  }

  #writeLastGoodSnapshot(directory) {
    // Preserve the last canonical state before replacing it. This is a recovery
    // artifact only: startup never restores it automatically because it may be stale.
    let canonical;
    try { canonical = readFileSync(this.statePath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    const parsed = this.#validatePersistedState(canonical);
    const backupPath = `${this.statePath}.last-good`;
    const backupTemp = `${backupPath}.${randomUUID()}.tmp`;
    let backupFd;
    try {
      backupFd = openSync(backupTemp, 'wx', 0o600);
      writeFileSync(backupFd, `${JSON.stringify(parsed)}\n`, 'utf8');
      fsyncSync(backupFd);
      closeSync(backupFd);
      backupFd = undefined;
      renameSync(backupTemp, backupPath);
      this.syncDirectory(directory);
    } catch (error) {
      if (backupFd !== undefined) { try { closeSync(backupFd); } catch {} }
      try { unlinkSync(backupTemp); } catch {}
      throw Object.assign(new Error('Could not persist last-good recovery snapshot; canonical state was not changed', { cause: error }), {
        code: 'NOTIFICATION_STORE_RECOVERY_SNAPSHOT_FAILED', commitVisible: false,
      });
    }
  }

  #validatePersistedState(serialized) {
    let value;
    try { value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized; }
    catch (cause) {
      throw Object.assign(new Error('Persisted notification state is not valid JSON; original file was preserved', { cause }), {
        code: 'NOTIFICATION_STORE_CORRUPT', statePath: this.statePath,
      });
    }
    // Reuse the exact validation path for canonical and recovery snapshots by
    // temporarily validating the parsed object through a pure schema helper.
    return this.#validateStateObject(value);
  }

  #save() {
    const directory = dirname(this.statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    let fd;
    try {
      this.#writeLastGoodSnapshot(directory);
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(this.state)}\n`, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.statePath);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      // Before rename, no commit is visible at the canonical path: restore memory.
      this.state = structuredClone(this.persistedStateSnapshot);
      throw error;
    }

    // After rename the new snapshot is visible. Do not roll memory back if directory
    // fsync fails: that would disagree with the canonical file currently on disk.
    // Surface the durability uncertainty so callers can avoid external side effects;
    // the next operation reloads the canonical file under the lock.
    this.persistedStateSnapshot = structuredClone(this.state);
    try {
      this.syncDirectory(directory);
    } catch (cause) {
      throw Object.assign(new Error('Notification state was atomically replaced, but directory durability could not be confirmed', { cause }), {
        code: 'NOTIFICATION_STORE_DURABILITY_UNCONFIRMED',
        commitVisible: true,
      });
    }
  }
}

/** Bridges policy events to the durable outbox. Optional inline delivery is fenced
 * with the same claim/intent/ambiguity protocol as the background worker. */
export function createInactivityNotificationAdapter({ store, ownerIdentityId, deliver = null } = {}) {
  if (!store || typeof store.enqueue !== 'function' || typeof store.list !== 'function' ||
      typeof store.claimDelivery !== 'function' || typeof store.recordAttempt !== 'function' ||
      typeof store.markDeliveryStarted !== 'function' || typeof store.markDeliveryAmbiguous !== 'function' ||
      typeof store.releaseDeliveryClaim !== 'function' || typeof store.confirmDelivered !== 'function' ||
      typeof ownerIdentityId !== 'string' || !ownerIdentityId.trim() ||
      (deliver !== null && typeof deliver !== 'function')) throw new TypeError('Invalid inactivity notification adapter configuration');
  return async event => {
    const eventKey = event?.type && Number.isSafeInteger(event.deadlineAt) ? `${event.type}:${event.deadlineAt}` : null;
    const result = await store.enqueue({ ownerIdentityId, event, eventKey });
    const notification = result.notification;
    if (!deliver) return Object.freeze({ queued: true, delivered: notification.deliveryStatus === 'delivered', id: notification.id });
    if (notification.deliveryStatus === 'delivered') return Object.freeze({ queued: true, delivered: true, id: notification.id });
    if (notification.deliveryStatus === 'ambiguous') return Object.freeze({ queued: true, delivered: false, ambiguous: true, id: notification.id });

    const claim = await store.claimDelivery(ownerIdentityId, notification.id);
    if (!claim) {
      const current = (await store.list(ownerIdentityId, { limit: 500 })).find(item => item.id === notification.id);
      return Object.freeze({ queued: true, delivered: current?.deliveryStatus === 'delivered',
        ambiguous: current?.deliveryStatus === 'ambiguous', id: notification.id });
    }
    let dispatchStarted = false;
    try {
      await store.recordAttempt(ownerIdentityId, notification.id, claim.claimToken);
      await store.markDeliveryStarted(ownerIdentityId, notification.id, claim.claimToken);
      dispatchStarted = true;
      let delivery;
      try {
        delivery = await deliver(Object.freeze({ ...notification,
          idempotencyKey: `zion-inactivity-notification:${notification.id}` }));
      } catch (error) {
        await store.markDeliveryAmbiguous(ownerIdentityId, notification.id, claim.claimToken,
          error?.code || 'provider-outcome-unknown');
        dispatchStarted = false;
        return Object.freeze({ queued: true, delivered: false, ambiguous: true, id: notification.id });
      }
      if (delivery?.delivered === true && typeof delivery.receipt === 'string' && delivery.receipt.trim()) {
        try {
          await store.confirmDelivered(ownerIdentityId, notification.id, delivery.receipt, claim.claimToken);
          dispatchStarted = false;
          return Object.freeze({ queued: true, delivered: true, id: notification.id });
        } catch {
          try {
            await store.markDeliveryAmbiguous(ownerIdentityId, notification.id, claim.claimToken, 'receipt-persistence-failed');
            dispatchStarted = false;
          } catch { /* Keep durable intent + lease so expiry recovery fences a resend. */ }
          return Object.freeze({ queued: true, delivered: false, ambiguous: true, id: notification.id });
        }
      }
      // An explicit negative response is the adapter contract for a known non-delivery.
      await store.releaseDeliveryClaim(ownerIdentityId, notification.id, claim.claimToken);
      dispatchStarted = false;
      return Object.freeze({ queued: true, delivered: false, id: notification.id });
    } catch {
      if (dispatchStarted) {
        try { await store.markDeliveryAmbiguous(ownerIdentityId, notification.id, claim.claimToken, 'delivery-state-persistence-failed'); } catch {}
      } else {
        try { await store.releaseDeliveryClaim(ownerIdentityId, notification.id, claim.claimToken); } catch {}
      }
      return Object.freeze({ queued: true, delivered: false, ambiguous: dispatchStarted, id: notification.id });
    }
  };
}
