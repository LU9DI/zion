import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync, readdirSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnoseWitnessEvidence } from '../scripts/diagnose-witness-evidence.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-witness-diagnostic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, target: join(dir, 'evidence.json') };
}

test('diagnostic classifies valid-JSON orphan without claiming it is trusted evidence', t => {
  const { dir, target } = fixture(t);
  const bytes = '{"signature":"unverified"}\n';
  const temp = join(dir, `evidence.json.${randomUUID()}.tmp`);
  writeFileSync(temp, bytes, { mode: 0o600 });
  const before = readFileSync(temp);
  const report = diagnoseWitnessEvidence(target);
  assert.equal(report.mode, 'read-only-diagnostic');
  assert.equal(report.recoveryPerformed, false);
  assert.equal(report.artifactCount, 1);
  assert.equal(report.artifacts[0].classification, 'orphan-json-syntax-valid');
  assert.match(report.artifacts[0].note, /signature, identity, freshness/);
  assert.deepEqual(readFileSync(temp), before);
  assert.equal(readdirSync(dir).length, 1);
});

test('diagnostic labels malformed JSON and preserves its bytes', t => {
  const { dir, target } = fixture(t);
  const temp = join(dir, `evidence.json.${randomUUID()}.tmp`);
  writeFileSync(temp, '{"partial":', { mode: 0o600 });
  const report = diagnoseWitnessEvidence(target);
  assert.equal(report.artifacts[0].classification, 'orphan-invalid-json');
  assert.equal(readFileSync(temp, 'utf8'), '{"partial":');
});

test('diagnostic identifies a post-publication hard-link alias by inode, not filename alone', t => {
  const { dir, target } = fixture(t);
  const temp = join(dir, `evidence.json.${randomUUID()}.tmp`);
  writeFileSync(temp, '{"complete":true}\n', { mode: 0o600 });
  linkSync(temp, target);
  const report = diagnoseWitnessEvidence(target);
  assert.equal(report.artifacts[0].classification, 'published-alias');
  assert.equal(report.artifacts[0].aliasesDestination, true);
  assert.equal(lstatSync(temp).ino, lstatSync(target).ino);
  assert.equal(readdirSync(dir).length, 2, 'diagnostic does not clean up alias');
});

test('diagnostic ignores unrelated suffixes and never follows a symlink', t => {
  const { dir, target } = fixture(t);
  const unrelated = join(dir, 'evidence.json.manual.tmp');
  const link = join(dir, `evidence.json.${randomUUID()}.tmp`);
  writeFileSync(unrelated, 'leave me');
  symlinkSync(unrelated, link);
  const report = diagnoseWitnessEvidence(target);
  assert.equal(report.artifactCount, 1);
  assert.equal(report.artifacts[0].classification, 'unreadable-or-nonregular');
  assert.equal(readFileSync(unrelated, 'utf8'), 'leave me');
  assert.equal(readdirSync(dir).length, 2);
});

test('diagnostic handles no artifacts and existing destination without changing it', t => {
  const { target } = fixture(t);
  const sentinel = '{"prior":"immutable"}\n';
  writeFileSync(target, sentinel, { mode: 0o600 });
  const report = diagnoseWitnessEvidence(target);
  assert.equal(report.destination.exists, true);
  assert.equal(report.artifactCount, 0);
  assert.equal(readFileSync(target, 'utf8'), sentinel);
});


test('diagnostic refuses to read or hash oversized temporary artifacts', t => {
  const { dir, target } = fixture(t);
  const temp = join(dir, `evidence.json.${randomUUID()}.tmp`);
  writeFileSync(temp, '');
  truncateSync(temp, 1024 * 1024 + 1);
  const report = diagnoseWitnessEvidence(target);
  assert.equal(report.artifacts[0].classification, 'oversized-uninspected');
  assert.equal(report.artifacts[0].bytesRead, 0);
  assert.equal('sha256' in report.artifacts[0], false);
  assert.equal(lstatSync(temp).size, 1024 * 1024 + 1);
});
