import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const HEX256 = /^[a-f0-9]{64}$/;
const MAX_FILES = 5000;
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Integrity manifest numbers must be safe non-negative integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported integrity manifest value');
};

/**
 * Verifies a release manifest signed by an externally pinned Ed25519 public key.
 * The manifest and public key must be provisioned independently of the files being checked.
 * This module is defense-in-depth, not a secure-boot boundary against an administrator/root attacker.
 */
export class IntegrityGuard {
  constructor({ root, manifest, trustedPublicKey, expectedReleaseVersion, requiredPaths, verificationIntervalMs = 5000, onQuarantine = null } = {}) {
    if (typeof root !== 'string' || !root || !manifest || typeof trustedPublicKey !== 'string' || !trustedPublicKey.trim()) {
      throw new TypeError('IntegrityGuard requires root, manifest, and an externally trusted public key');
    }
    if (typeof expectedReleaseVersion !== 'string' || !expectedReleaseVersion) throw new TypeError('A pinned expected release version is required');
    if (!Array.isArray(requiredPaths) || requiredPaths.length < 1 || requiredPaths.some(p => typeof p !== 'string' || !p || path.isAbsolute(p) || p.includes('\\') || p.split('/').some(part => !part || part === '.' || part === '..')) || new Set(requiredPaths).size !== requiredPaths.length) throw new TypeError('A non-empty list of required critical paths is required');
    if (!Number.isSafeInteger(verificationIntervalMs) || verificationIntervalMs < 1000 || verificationIntervalMs > 60_000) throw new TypeError('Invalid integrity verification interval');
    if (onQuarantine !== null && typeof onQuarantine !== 'function') throw new TypeError('onQuarantine must be a function');
    this.root = path.resolve(root);
    this.manifest = manifest;
    this.trustedPublicKey = createPublicKey(trustedPublicKey);
    if (this.trustedPublicKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Integrity manifest key must be Ed25519');
    this.expectedReleaseVersion = expectedReleaseVersion;
    this.requiredPaths = Object.freeze([...requiredPaths]);
    this.verificationIntervalMs = verificationIntervalMs;
    this.lastVerifiedAt = 0;
    this.onQuarantine = onQuarantine;
    this.quarantineListeners = new Set();
    this.verified = false;
    this.quarantined = false;
    this.reason = 'not-verified';
    this.lastReport = null;
  }

  async verify() {
    if (this.quarantined) return this.lastReport ?? { ok: false, reason: this.reason };
    try {
      // Snapshot the complete manifest synchronously before the first await. The
      // signature and file checks must operate on the same immutable-by-ownership
      // data; otherwise a caller mutating a shared manifest object during I/O could
      // change paths or hashes after signature verification.
      // Snapshot every security-critical setting before canonicalizing the
      // manifest or beginning filesystem I/O. Public properties can otherwise
      // be reassigned while asynchronous verification is in flight.
      const root = this.root;
      const expectedReleaseVersion = this.expectedReleaseVersion;
      const requiredPaths = this.requiredPaths;
      const trustedPublicKey = this.trustedPublicKey;
      const m = JSON.parse(canonical(this.manifest));
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('release-root-not-real-directory');
      const resolvedRoot = await realpath(root);
      if (!m || m.version !== 1 || typeof m.releaseVersion !== 'string' || !Array.isArray(m.files) || m.files.length < 1 || m.files.length > MAX_FILES) throw new Error('invalid-manifest-shape');
      if (expectedReleaseVersion && m.releaseVersion !== expectedReleaseVersion) throw new Error('release-version-mismatch');
      const seen = new Set();
      for (const file of m.files) {
        if (!file || typeof file.path !== 'string' || !file.path || path.isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || !HEX256.test(file.sha256 ?? '')) throw new Error('invalid-manifest-entry');
        if (seen.has(file.path)) throw new Error('duplicate-manifest-path');
        seen.add(file.path);
      }
      for (const requiredPath of requiredPaths) if (!m.files.some(file => file?.path === requiredPath)) throw new Error(`required-file-missing:${requiredPath}`);
      const { signature, ...core } = m;
      if (Buffer.byteLength(canonical(core), 'utf8') > 2 * 1024 * 1024) throw new Error('manifest-too-large');
      if (typeof signature !== 'string' || signature.length > 2048) throw new Error('missing-manifest-signature');
      const signatureBytes = Buffer.from(signature, 'base64');
      if (!signatureBytes.length || signatureBytes.toString('base64') !== signature || !verifySignature(null, Buffer.from(canonical(core)), trustedPublicKey, signatureBytes)) throw new Error('invalid-manifest-signature');
      const checked = [];
      for (const entry of m.files) {
        const target = path.resolve(root, ...entry.path.split('/'));
        if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new Error('manifest-path-escape');
        let current = root;
        for (const segment of entry.path.split('/')) {
          current = path.join(current, segment);
          const st = await lstat(current);
          if (st.isSymbolicLink()) throw new Error(`symlink-not-allowed:${entry.path}`);
          if (current !== target && !st.isDirectory()) throw new Error(`invalid-parent-path:${entry.path}`);
          if (current === target && !st.isFile()) throw new Error(`not-a-regular-file:${entry.path}`);
        }
        const actualRealPath = await realpath(target);
        if (!actualRealPath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`file-escapes-release-root:${entry.path}`);
        const bytes = await readFile(target);
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== entry.sha256) throw new Error(`hash-mismatch:${entry.path}`);
        checked.push(entry.path);
      }
      // Another overlapping verification may have quarantined this guard while
      // this invocation was awaiting filesystem I/O. Quarantine is monotonic: a
      // later-finishing successful scan must never overwrite its failure report.
      if (this.quarantined) return this.lastReport ?? { ok: false, reason: this.reason };
      this.verified = true;
      this.lastVerifiedAt = Date.now();
      this.reason = null;
      this.lastReport = Object.freeze({ ok: true, releaseVersion: m.releaseVersion, checkedFiles: checked.length, files: Object.freeze(checked) });
      return this.lastReport;
    } catch (error) {
      this.verified = false;
      this.quarantined = true;
      this.reason = typeof error?.message === 'string' ? error.message.slice(0, 240) : 'integrity-verification-failed';
      this.lastReport = Object.freeze({ ok: false, reason: this.reason });
      // Alerting is best-effort and must never gate containment or verification
      // completion: external sinks can hang indefinitely. Attach a rejection
      // handler immediately so an alert failure cannot become unhandled.
      if (this.onQuarantine) {
        void Promise.resolve().then(() => this.onQuarantine(this.lastReport)).catch(() => {});
      }
      // Invoke all local containment listeners concurrently. Their completion is
      // part of quarantine handling; external alert delivery is not.
      const notifications = [...this.quarantineListeners].map(listener =>
        Promise.resolve().then(() => listener(this.lastReport)));
      await Promise.allSettled(notifications);
      return this.lastReport;
    }
  }

  /** Register a local subsystem that must shed pending work on quarantine. */
  addQuarantineListener(listener) {
    if (typeof listener !== 'function') throw new TypeError('Quarantine listener must be a function');
    this.quarantineListeners.add(listener);
    if (this.quarantined) Promise.resolve().then(() => listener(this.lastReport)).catch(() => {});
    return () => this.quarantineListeners.delete(listener);
  }

  /** Re-checks the signed manifest; any later mismatch permanently quarantines this instance. */
  async reverify() {
    if (this.quarantined) return this.lastReport;
    this.verified = false;
    return this.verify();
  }

  /** Re-checks disk integrity when the last successful verification becomes stale. */
  async checkHealthy() {
    if (this.quarantined) this.assertHealthy();
    if (!this.verified) this.assertHealthy();
    if (Date.now() - this.lastVerifiedAt >= this.verificationIntervalMs) await this.reverify();
    this.assertHealthy();
  }

  /** Synchronous state check; use checkHealthy() at security-sensitive boundaries. */
  assertHealthy() {
    if (!this.verified || this.quarantined) {
      const error = new Error(`Zion integrity guard is not healthy: ${this.reason ?? 'verification-required'}`);
      error.code = 'ZION_INTEGRITY_QUARANTINED';
      throw error;
    }
  }

  get status() {
    return Object.freeze({ verified: this.verified, quarantined: this.quarantined, reason: this.reason });
  }
}

/** Build the unsigned portion of a release manifest. Release tooling must sign it offline. */
export function createIntegrityManifestCore(releaseVersion, files) {
  if (typeof releaseVersion !== 'string' || !releaseVersion || !Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) throw new TypeError('Invalid release manifest inputs');
  const normalized = files.map(file => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set();
  for (const file of normalized) {
    if (typeof file.path !== 'string' || path.isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..') || !HEX256.test(file.sha256 ?? '') || seen.has(file.path)) throw new TypeError('Invalid or duplicate release manifest entry');
    seen.add(file.path);
  }
  return Object.freeze({ version: 1, releaseVersion, files: Object.freeze(normalized.map(Object.freeze)) });
}

export function integrityManifestDigest(manifestCore) {
  return createHash('sha256').update(canonical(manifestCore)).digest('hex');
}
