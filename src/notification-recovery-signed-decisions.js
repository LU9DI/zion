import { closeSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID, sign as cryptoSign, verify as cryptoVerify, createPublicKey } from 'node:crypto';
import { join, resolve } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ID_RE = /^[a-f0-9-]{36}$/i;
const KEY_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const ACTIONS = new Set(['keep_pending', 'investigate', 'authorize_manual_retry']);
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function syncDirectory(path) {
  // Node.js cannot reliably fsync directory handles on Windows (EPERM).
  // The signed record itself is fsynced before publication; directory-entry durability is weaker there.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function assertDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('NOTIFICATION_SIGNED_DECISION_UNSAFE_DIRECTORY', 'Decision directory must be a real directory');
}
function canonicalBody(record) {
  return JSON.stringify({ schemaVersion: record.schemaVersion, decisionId: record.decisionId, caseId: record.caseId,
    reportSha256: record.reportSha256, action: record.action, approver: record.approver, rationale: record.rationale,
    keyId: record.keyId, issuedAt: record.issuedAt, expiresAt: record.expiresAt, executionPerformed: false });
}

/** Ed25519-signed, append-only recovery decisions. Signatures authorize review decisions only; this class never executes delivery. */
export class NotificationRecoverySignedDecisionStore {
  constructor({ casebook, directory, trustedPublicKeys = {}, revokedKeyIds = [], trustRegistry = null } = {}) {
    if (!casebook || typeof casebook.read !== 'function') throw new TypeError('A casebook with read(caseId) is required');
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Decision directory is required');
    if (!trustedPublicKeys || typeof trustedPublicKeys !== 'object' || Array.isArray(trustedPublicKeys)) throw new TypeError('Trusted public keys must be an object keyed by key ID');
    this.casebook = casebook;
    this.directory = resolve(directory);
    this.trustedPublicKeys = new Map(Object.entries(trustedPublicKeys));
    if (trustRegistry !== null && (typeof trustRegistry.getPublicKey !== 'function' || typeof trustRegistry.isRevoked !== 'function')) throw new TypeError('trustRegistry must expose getPublicKey() and isRevoked()');
    this.trustRegistry = trustRegistry;
    this.revokedKeyIds = new Set(revokedKeyIds);
  }

  signDecision({ caseId, expectedReportSha256, action, approver, rationale, keyId, privateKey, decisionId = randomUUID(), ttlMs = 60 * 60 * 1000, now = Date.now() } = {}) {
    if (!ID_RE.test(caseId ?? '') || !ID_RE.test(decisionId ?? '')) throw new TypeError('Invalid case or decision ID');
    if (typeof expectedReportSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedReportSha256)) throw new TypeError('Expected report SHA-256 is required');
    if (!ACTIONS.has(action)) throw new TypeError('Unsupported recovery decision action');
    if (typeof approver !== 'string' || !approver.trim() || approver.length > 200) throw new TypeError('Approver is required');
    if (typeof rationale !== 'string' || rationale.trim().length < 8 || rationale.length > 4000) throw new TypeError('A rationale of 8–4000 characters is required');
    if (!KEY_ID_RE.test(keyId ?? '') || typeof privateKey !== 'string' && typeof privateKey !== 'object') throw new TypeError('A key ID and Ed25519 private key are required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw new TypeError('Decision TTL must be between 1 second and 24 hours');
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid decision timestamp');
    if (this.revokedKeyIds.has(keyId) || this.trustRegistry?.isRevoked(keyId)) throw fail('NOTIFICATION_SIGNED_DECISION_KEY_REVOKED', 'Signing key has been revoked');
    const publicKey = this.trustRegistry ? this.trustRegistry.getPublicKey(keyId) : this.trustedPublicKeys.get(keyId);
    if (!publicKey) throw fail('NOTIFICATION_SIGNED_DECISION_UNTRUSTED_KEY', 'Signing key ID is not trusted');
    const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const trustedPublic = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    if (!derivedPublic.equals(trustedPublic)) throw fail('NOTIFICATION_SIGNED_DECISION_KEY_MISMATCH', 'Private key does not match the trusted public key');
    const currentCase = this.casebook.read(caseId);
    if (!currentCase) throw fail('NOTIFICATION_SIGNED_DECISION_CASE_NOT_FOUND', 'Reconciliation case does not exist');
    if (currentCase.reportSha256 !== expectedReportSha256) throw fail('NOTIFICATION_SIGNED_DECISION_STALE_REPORT', 'Decision does not match the current report digest');

    const body = { schemaVersion: 1, decisionId, caseId, reportSha256: expectedReportSha256, action,
      approver: approver.trim(), rationale: rationale.trim(), keyId, issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(), executionPerformed: false };
    const signature = cryptoSign(null, Buffer.from(canonicalBody(body)), privateKey).toString('base64');
    const envelope = { ...body, signature, decisionSha256: sha256(canonicalBody(body)) };
    assertDirectory(this.directory);
    const target = join(this.directory, `signed-decision-${decisionId}.json`);
    const temp = join(this.directory, `.signed-decision-${decisionId}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temp, target); }
      catch (error) { if (error?.code === 'EEXIST') throw fail('NOTIFICATION_SIGNED_DECISION_DUPLICATE', 'Decision ID already exists'); throw error; }
      unlinkSync(temp); syncDirectory(this.directory);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
    return Object.freeze({ ...envelope, path: target, status: 'signed-recorded', executionPerformed: false });
  }

  verifyDecision(record, { now = Date.now() } = {}) {
    if (!record || !ID_RE.test(record.decisionId ?? '') || !ID_RE.test(record.caseId ?? '') || !ACTIONS.has(record.action) || record.executionPerformed !== false || !KEY_ID_RE.test(record.keyId ?? '')) {
      throw fail('NOTIFICATION_SIGNED_DECISION_INVALID_RECORD', 'Signed decision schema is invalid');
    }
    const { signature, decisionSha256, ...body } = record;
    const serialized = canonicalBody(body);
    if (sha256(serialized) !== decisionSha256) throw fail('NOTIFICATION_SIGNED_DECISION_INTEGRITY_FAILURE', 'Decision digest mismatch');
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw fail('NOTIFICATION_SIGNED_DECISION_INVALID_SIGNATURE', 'Signature encoding is invalid');
    if (this.revokedKeyIds.has(record.keyId) || this.trustRegistry?.isRevoked(record.keyId)) return Object.freeze({ ...record, status: 'revoked-key', signatureValid: false, approvalValid: false });
    const publicKey = this.trustRegistry ? this.trustRegistry.getPublicKey(record.keyId) : this.trustedPublicKeys.get(record.keyId);
    if (!publicKey) return Object.freeze({ ...record, status: 'untrusted-key', signatureValid: false, approvalValid: false });
    let signatureValid = false;
    try { signatureValid = cryptoVerify(null, Buffer.from(serialized), publicKey, Buffer.from(signature, 'base64')); } catch {}
    if (!signatureValid) throw fail('NOTIFICATION_SIGNED_DECISION_INVALID_SIGNATURE', 'Ed25519 signature verification failed');
    const issued = Date.parse(record.issuedAt), expires = Date.parse(record.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > MAX_TTL_MS || now < issued - 60_000) {
      return Object.freeze({ ...record, status: 'invalid-time-window', signatureValid: true, approvalValid: false });
    }
    if (now >= expires) return Object.freeze({ ...record, status: 'expired', signatureValid: true, approvalValid: false });
    const currentCase = this.casebook.read(record.caseId);
    if (!currentCase || currentCase.reportSha256 !== record.reportSha256) return Object.freeze({ ...record, status: 'stale-invalidated', signatureValid: true, approvalValid: false });
    return Object.freeze({ ...record, status: 'valid', signatureValid: true, approvalValid: true });
  }

  read(decisionId, options) {
    if (!ID_RE.test(decisionId ?? '')) throw new TypeError('Invalid decision ID');
    const path = join(this.directory, `signed-decision-${decisionId}.json`);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('NOTIFICATION_SIGNED_DECISION_UNSAFE_FILE', 'Decision entries must be regular files');
    return this.verifyDecision(JSON.parse(readFileSync(path, 'utf8')), options);
  }

  list(options) {
    let stat;
    try { stat = lstatSync(this.directory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('NOTIFICATION_SIGNED_DECISION_UNSAFE_DIRECTORY', 'Decision directory must be a real directory');
    return readdirSync(this.directory).filter(name => /^signed-decision-[a-f0-9-]{36}\.json$/i.test(name))
      .map(name => this.read(name.slice(16, -5), options)).filter(Boolean).sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  }
}
