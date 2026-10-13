import { closeSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
function syncDirectory(path) {
  // Node.js/Windows does not provide portable directory-handle fsync (often EPERM).
  // File contents are fsynced before publication; directory-entry durability is weaker on Windows.
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function validateReport(report) {
  if (!report || typeof report !== 'object' || report.schemaVersion !== 1 || report.mode !== 'read-only-no-retry' ||
      report.automaticResendsPerformed !== 0 || report.recordsMutated !== false || !report.counts ||
      !Number.isSafeInteger(report.counts.before) || !Number.isSafeInteger(report.counts.restored) ||
      !Array.isArray(report.missingAfterRestore) || !Array.isArray(report.deliveryStateRegressions) ||
      !Array.isArray(report.needsProviderReconciliation) || !Array.isArray(report.unresolved)) {
    throw Object.assign(new TypeError('Invalid notification recovery reconciliation report'), { code: 'NOTIFICATION_CASEBOOK_INVALID_REPORT' });
  }
  const raw = JSON.stringify(report);
  if (raw.length > 2_000_000) throw Object.assign(new RangeError('Reconciliation report exceeds size limit'), { code: 'NOTIFICATION_CASEBOOK_REPORT_TOO_LARGE' });
  return raw;
}

/** Local, append-only casebook for integrity-checked reconciliation reports. It does not retry delivery. */
export class NotificationRecoveryCasebook {
  constructor({ directory } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Casebook directory is required');
    this.directory = resolve(directory);
  }

  save(report, { caseId = randomUUID() } = {}) {
    if (typeof caseId !== 'string' || !/^[a-f0-9-]{36}$/i.test(caseId)) throw new TypeError('Invalid case ID');
    const reportJson = validateReport(report);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('Casebook path must be a real directory'), { code: 'NOTIFICATION_CASEBOOK_UNSAFE_DIRECTORY' });
    const reportSha256 = digest(reportJson);
    const envelope = { schemaVersion: 1, caseId, createdAt: new Date().toISOString(), reportSha256, report: JSON.parse(reportJson) };
    const content = `${JSON.stringify(envelope, null, 2)}\n`;
    const target = join(this.directory, `case-${caseId}.json`);
    const temp = join(this.directory, `.case-${caseId}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      // Hard-link publication is atomic and fails if the target already exists.
      try { linkSync(temp, target); }
      catch (error) { if (error?.code === 'EEXIST') throw Object.assign(new Error('Case ID already exists'), { code: 'NOTIFICATION_CASEBOOK_DUPLICATE_CASE' }); throw error; }
      unlinkSync(temp); syncDirectory(this.directory);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
    return Object.freeze({ caseId, path: target, reportSha256, status: 'saved' });
  }

  read(caseId) {
    if (typeof caseId !== 'string' || !/^[a-f0-9-]{36}$/i.test(caseId)) throw new TypeError('Invalid case ID');
    const path = join(this.directory, `case-${caseId}.json`);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('Casebook entries must be regular files'), { code: 'NOTIFICATION_CASEBOOK_UNSAFE_FILE' });
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    if (envelope?.schemaVersion !== 1 || envelope.caseId !== caseId || typeof envelope.reportSha256 !== 'string') {
      throw Object.assign(new Error('Invalid casebook envelope'), { code: 'NOTIFICATION_CASEBOOK_INVALID_ENVELOPE' });
    }
    const raw = JSON.stringify(envelope.report);
    if (digest(raw) !== envelope.reportSha256) throw Object.assign(new Error('Casebook report integrity check failed'), { code: 'NOTIFICATION_CASEBOOK_INTEGRITY_FAILURE' });
    validateReport(envelope.report);
    return Object.freeze({ ...envelope, path });
  }

  list() {
    let stat;
    try { stat = lstatSync(this.directory); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error('Casebook path must be a real directory'), { code: 'NOTIFICATION_CASEBOOK_UNSAFE_DIRECTORY' });
    return readdirSync(this.directory).filter(name => /^case-[a-f0-9-]{36}\.json$/i.test(name))
      .map(name => this.read(name.slice(5, -5))).filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
