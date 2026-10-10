import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseTrustedHistoryState } from '../scripts/diagnose-trusted-history-state.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
function validState(revision = 3) {
  const body = { schemaVersion: 1, lastRevision: revision, lastCheckpointSha256: 'a'.repeat(64), headIssuedAt: 1234 };
  return JSON.stringify({ ...body, stateSha256: sha256(JSON.stringify(body)) }) + '\n';
}

test('reports absent state and lock without mutating the directory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-state-diag-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const result = diagnoseTrustedHistoryState({ statePath: path });
  assert.equal(result.readOnly, true); assert.equal(result.disposition, 'no-state-no-lock');
});

test('validates the state checksum and reports a present lock conservatively', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-state-diag-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); writeFileSync(path, validState()); writeFileSync(`${path}.lock`, '999999999\n');
  const result = diagnoseTrustedHistoryState({ statePath: path });
  assert.equal(result.state.status, 'valid'); assert.equal(result.state.lastRevision, 3); assert.equal(result.lock.status, 'present');
  assert.equal(result.disposition, 'possible-abandoned-lock-manual-review');
});

test('flags corrupt state and never repairs it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-state-diag-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); writeFileSync(path, '{broken');
  const result = diagnoseTrustedHistoryState({ statePath: path });
  assert.equal(result.state.status, 'invalid-or-unreadable'); assert.equal(result.readOnly, true);
});

test('rejects a symlink state path where O_NOFOLLOW is supported', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-state-diag-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, 'real.json'); const link = join(dir, 'link.json'); writeFileSync(real, validState());
  try { symlinkSync(real, link); } catch { return; }
  const result = diagnoseTrustedHistoryState({ statePath: link });
  assert.equal(result.state.status, 'invalid-or-unreadable');
});
