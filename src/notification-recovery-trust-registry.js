import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID, createPublicKey } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const KEY_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const canonical = state => JSON.stringify({ schemaVersion: state.schemaVersion, revision: state.revision, keys: state.keys, events: state.events });
function syncDirectory(path) {
  // Directory-handle fsync is not portable in Node.js on Windows (EPERM).
  // State and lock files are still fsynced; directory-entry durability is weaker on Windows.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function validatePublicKey(publicKey) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('Trusted recovery keys must be Ed25519 public keys');
  return key.export({ type: 'spki', format: 'pem' });
}

/** Persistent local trust registry. File integrity is checked, but the registry is not tamper-proof against its filesystem administrator. */
export class NotificationRecoveryTrustRegistry {
  constructor({ statePath } = {}) {
    if (typeof statePath !== 'string' || !statePath.trim()) throw new TypeError('Trust registry statePath is required');
    this.statePath = resolve(statePath);
    this.directory = dirname(this.statePath);
    this.lockPath = `${this.statePath}.lock`;
    this.lockTimeoutMs = 5000;
    this.state = this.#load();
  }

  #withLock(operation) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    let lockFd;
    while (lockFd === undefined) {
      try {
        lockFd = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: randomUUID() }));
        fsyncSync(lockFd);
      } catch (error) {
        if (lockFd !== undefined) {
          try { closeSync(lockFd); } catch {}
          lockFd = undefined;
          try { unlinkSync(this.lockPath); } catch {}
        }
        if (error?.code !== 'EEXIST') throw error;
        // Only reclaim a lock when its recorded owner is demonstrably gone.
        try {
          const st = lstatSync(this.lockPath);
          if (st.isFile() && !st.isSymbolicLink()) {
            const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
            if (Number.isSafeInteger(lock.pid) && lock.pid > 0) {
              let alive = true;
              try { process.kill(lock.pid, 0); } catch (probe) { if (probe?.code === 'ESRCH') alive = false; }
              if (!alive) { try { unlinkSync(this.lockPath); } catch (removeError) { if (removeError?.code !== 'ENOENT') throw removeError; } continue; }
            }
          }
        } catch (inspectError) { if (inspectError?.code !== 'ENOENT') { /* malformed locks time out rather than being unsafely stolen */ } }
        if (Date.now() >= deadline) throw fail('NOTIFICATION_TRUST_REGISTRY_LOCK_TIMEOUT', 'Timed out waiting for trust registry lock');
        // Synchronous API: short bounded wait without spinning at full CPU.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      this.#refresh();
      return operation();
    } finally {
      try { closeSync(lockFd); } catch {}
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, 'utf8'));
        if (lock.pid === process.pid) unlinkSync(this.lockPath);
      } catch {}
    }
  }

  #appendEvent(next, event) {
    const previous = [...next.events].reverse().find(item => typeof item.eventHash === 'string')?.eventHash ?? '0'.repeat(64);
    const body = { ...event, previousEventHash: previous };
    body.eventHash = sha256(JSON.stringify(body));
    next.events.push(body);
  }

  #validateEventChain(events) {
    let previous = '0'.repeat(64);
    for (const event of events) {
      if (typeof event.eventHash !== 'string' && typeof event.previousEventHash !== 'string') continue; // legacy events remain readable
      if (typeof event.eventHash !== 'string' || event.previousEventHash !== previous) throw fail('NOTIFICATION_TRUST_REGISTRY_AUDIT_CHAIN_FAILURE', 'Trust registry audit chain is invalid');
      const { eventHash, ...body } = event;
      if (sha256(JSON.stringify(body)) !== eventHash) throw fail('NOTIFICATION_TRUST_REGISTRY_AUDIT_CHAIN_FAILURE', 'Trust registry audit event hash mismatch');
      previous = eventHash;
    }
  }

  #empty() { return { schemaVersion: 1, revision: 0, keys: {}, events: [], stateSha256: '' }; }

  #load() {
    let stat;
    try { stat = lstatSync(this.statePath); } catch (error) { if (error?.code === 'ENOENT') return this.#empty(); throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('NOTIFICATION_TRUST_REGISTRY_UNSAFE_FILE', 'Trust registry must be a regular file');
    let state;
    try { state = JSON.parse(readFileSync(this.statePath, 'utf8')); } catch { throw fail('NOTIFICATION_TRUST_REGISTRY_CORRUPT', 'Trust registry JSON is invalid'); }
    if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys) || !Array.isArray(state.events) || typeof state.stateSha256 !== 'string') throw fail('NOTIFICATION_TRUST_REGISTRY_CORRUPT', 'Trust registry schema is invalid');
    if (sha256(canonical(state)) !== state.stateSha256) throw fail('NOTIFICATION_TRUST_REGISTRY_INTEGRITY_FAILURE', 'Trust registry digest mismatch');
    this.#validateEventChain(state.events);
    for (const [keyId, entry] of Object.entries(state.keys)) {
      if (!KEY_ID_RE.test(keyId) || !entry || typeof entry.publicKey !== 'string' || typeof entry.revoked !== 'boolean' || !Array.isArray(entry.permissions)) throw fail('NOTIFICATION_TRUST_REGISTRY_CORRUPT', 'Trust registry key entry is invalid');
      try { validatePublicKey(entry.publicKey); } catch { throw fail('NOTIFICATION_TRUST_REGISTRY_CORRUPT', 'Trust registry contains an invalid public key'); }
    }
    return state;
  }

  #save(next) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const dirStat = lstatSync(this.directory);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw fail('NOTIFICATION_TRUST_REGISTRY_UNSAFE_DIRECTORY', 'Trust registry directory must be a real directory');
    next.stateSha256 = sha256(canonical(next));
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      // Windows can transiently reject replacement while another process has a read handle
      // open (EPERM/EBUSY). The registry lock serializes writers; retry the same atomic rename
      // briefly rather than deleting the committed state or failing a valid concurrent mutation.
      const renameDeadline = Date.now() + 1000;
      while (true) {
        try { renameSync(temp, this.statePath); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= renameDeadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      syncDirectory(this.directory);
      this.state = next;
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }

  #refresh() { this.state = this.#load(); return this.state; }

  trustKey({ keyId, publicKey, permissions = ['sign_recovery_decision'], actor, reason, now = Date.now() } = {}) {
    if (!KEY_ID_RE.test(keyId ?? '')) throw new TypeError('Invalid key ID');
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) throw new TypeError('Trust registry actor is required');
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 1000) throw new TypeError('A trust reason of 8–1000 characters is required');
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid event timestamp');
    if (!Array.isArray(permissions) || permissions.length === 0 || permissions.some(p => p !== 'sign_recovery_decision')) throw new TypeError('Unsupported trust permission');
    const normalizedKey = validatePublicKey(publicKey);
    return this.#withLock(() => {
    const previous = this.state.keys[keyId];
    if (previous && previous.publicKey !== normalizedKey) throw fail('NOTIFICATION_TRUST_REGISTRY_KEY_ID_CONFLICT', 'Key ID is already bound to a different public key; use a new key ID');
    if (previous?.revoked) throw fail('NOTIFICATION_TRUST_REGISTRY_KEY_REVOKED', 'A revoked key ID cannot be reactivated; use a new key ID');
    if (previous) throw fail('NOTIFICATION_TRUST_REGISTRY_KEY_EXISTS', 'Key ID is already trusted');
    const next = structuredClone(this.state);
    next.revision++;
    next.keys[keyId] = { publicKey: normalizedKey, revoked: false, permissions: [...new Set(permissions)], trustedAt: new Date(now).toISOString(), trustedBy: actor.trim() };
    this.#appendEvent(next, { revision: next.revision, type: 'key-trusted', keyId, actor: actor.trim(), reason: reason.trim(), at: new Date(now).toISOString() });
    this.#save(next);
    return this.getKey(keyId);
    });
  }

  revokeKey({ keyId, actor, reason, now = Date.now() } = {}) {
    if (!KEY_ID_RE.test(keyId ?? '')) throw new TypeError('Invalid key ID');
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) throw new TypeError('Trust registry actor is required');
    if (typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 1000) throw new TypeError('A revocation reason of 8–1000 characters is required');
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid event timestamp');
    return this.#withLock(() => {
    const entry = this.state.keys[keyId];
    if (!entry) throw fail('NOTIFICATION_TRUST_REGISTRY_KEY_NOT_FOUND', 'Key ID is not registered');
    if (entry.revoked) return this.getKey(keyId);
    const next = structuredClone(this.state);
    next.revision++;
    next.keys[keyId] = { ...entry, revoked: true, revokedAt: new Date(now).toISOString(), revokedBy: actor.trim() };
    this.#appendEvent(next, { revision: next.revision, type: 'key-revoked', keyId, actor: actor.trim(), reason: reason.trim(), at: new Date(now).toISOString() });
    this.#save(next);
    return this.getKey(keyId);
    });
  }

  getKey(keyId) {
    this.#refresh();
    const entry = this.state.keys[keyId];
    return entry ? Object.freeze({ keyId, ...structuredClone(entry) }) : null;
  }

  getPublicKey(keyId, permission = 'sign_recovery_decision') {
    const entry = this.getKey(keyId);
    if (!entry || entry.revoked || !entry.permissions.includes(permission)) return null;
    return entry.publicKey;
  }

  isRevoked(keyId) { const entry = this.getKey(keyId); return Boolean(entry?.revoked); }
  list() { this.#refresh(); return Object.entries(this.state.keys).map(([keyId, entry]) => Object.freeze({ keyId, ...structuredClone(entry) })); }
  auditEvents() { this.#refresh(); return structuredClone(this.state.events); }
  get revision() { this.#refresh(); return this.state.revision; }
}
