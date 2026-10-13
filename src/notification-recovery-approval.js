import { closeSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ID_RE = /^[a-f0-9-]{36}$/i;
const ACTIONS = new Set(['keep_pending', 'investigate', 'authorize_manual_retry']);
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function syncDirectory(path) {
  // Node.js cannot reliably fsync directory handles on Windows (EPERM).
  // The record itself is fsynced before publication; directory-entry durability is weaker there.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function assertDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('NOTIFICATION_APPROVAL_UNSAFE_DIRECTORY', 'Approval directory must be a real directory');
}

/** Durable, append-only operator decisions bound to the exact case report digest. Never executes delivery. */
export class NotificationRecoveryApprovalWorkflow {
  constructor({ casebook, directory } = {}) {
    if (!casebook || typeof casebook.read !== 'function') throw new TypeError('A NotificationRecoveryCasebook-compatible instance is required');
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Approval directory is required');
    this.casebook = casebook;
    this.directory = resolve(directory);
  }

  approve({ caseId, expectedReportSha256, action, approver, rationale, decisionId = randomUUID() } = {}) {
    if (!ID_RE.test(caseId ?? '') || !ID_RE.test(decisionId ?? '')) throw new TypeError('Invalid case or decision ID');
    if (typeof expectedReportSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedReportSha256)) throw new TypeError('Expected report SHA-256 is required');
    if (!ACTIONS.has(action)) throw new TypeError('Unsupported recovery decision action');
    if (typeof approver !== 'string' || !approver.trim() || approver.length > 200) throw new TypeError('Approver is required');
    if (typeof rationale !== 'string' || rationale.trim().length < 8 || rationale.length > 4000) throw new TypeError('A rationale of 8–4000 characters is required');

    const currentCase = this.casebook.read(caseId);
    if (!currentCase) throw fail('NOTIFICATION_APPROVAL_CASE_NOT_FOUND', 'Reconciliation case does not exist');
    if (currentCase.reportSha256 !== expectedReportSha256) throw fail('NOTIFICATION_APPROVAL_STALE_REPORT', 'Approval does not match the current report digest');

    assertDirectory(this.directory);
    const record = {
      schemaVersion: 1, decisionId, caseId, reportSha256: expectedReportSha256,
      action, approver: approver.trim(), rationale: rationale.trim(),
      executionPerformed: false, createdAt: new Date().toISOString()
    };
    const body = JSON.stringify(record);
    const envelope = { ...record, decisionSha256: sha256(body) };
    const content = `${JSON.stringify(envelope, null, 2)}\n`;
    const target = join(this.directory, `decision-${decisionId}.json`);
    const temp = join(this.directory, `.decision-${decisionId}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      try { linkSync(temp, target); }
      catch (error) { if (error?.code === 'EEXIST') throw fail('NOTIFICATION_APPROVAL_DUPLICATE_DECISION', 'Decision ID already exists'); throw error; }
      unlinkSync(temp); syncDirectory(this.directory);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
    return Object.freeze({ ...envelope, path: target, status: 'recorded' });
  }

  read(decisionId) {
    if (!ID_RE.test(decisionId ?? '')) throw new TypeError('Invalid decision ID');
    const path = join(this.directory, `decision-${decisionId}.json`);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw fail('NOTIFICATION_APPROVAL_UNSAFE_FILE', 'Decision entries must be regular files');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const { decisionSha256, ...body } = record;
    if (record.schemaVersion !== 1 || record.decisionId !== decisionId || !ACTIONS.has(record.action) || record.executionPerformed !== false || sha256(JSON.stringify(body)) !== decisionSha256) {
      throw fail('NOTIFICATION_APPROVAL_INTEGRITY_FAILURE', 'Decision record integrity check failed');
    }
    const currentCase = this.casebook.read(record.caseId);
    if (!currentCase || currentCase.reportSha256 !== record.reportSha256) {
      return Object.freeze({ ...record, path, status: 'stale-invalidated', approvalValid: false });
    }
    return Object.freeze({ ...record, path, status: 'valid', approvalValid: true });
  }

  list() {
    let stat;
    try { stat = lstatSync(this.directory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('NOTIFICATION_APPROVAL_UNSAFE_DIRECTORY', 'Approval directory must be a real directory');
    return readdirSync(this.directory).filter(name => /^decision-[a-f0-9-]{36}\.json$/i.test(name))
      .map(name => this.read(name.slice(9, -5))).filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
