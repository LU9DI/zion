import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistTrustedHistoryState } from '../scripts/persist-trusted-history-state.js';

const result = (revision, hashChar = 'a', issuedAt = 1000) => ({ valid: true, lastRevision: revision, lastCheckpointSha256: hashChar.repeat(64), headIssuedAt: issuedAt });
test('persists the verified head and does not rewrite the same head', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-trust-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const first = persistTrustedHistoryState({ statePath: path, verification: result(5) });
  assert.equal(first.updated, true); assert.equal(first.state.lastRevision, 5);
  const second = persistTrustedHistoryState({ statePath: path, verification: result(5) });
  assert.equal(second.updated, false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).lastRevision, 5);
});
test('rejects revision rollback, same-revision forks, and timestamp rollback', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-trust-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); persistTrustedHistoryState({ statePath: path, verification: result(8, 'b', 2000) });
  assert.throws(() => persistTrustedHistoryState({ statePath: path, verification: result(7, 'a', 3000) }), /rollback detected/);
  assert.throws(() => persistTrustedHistoryState({ statePath: path, verification: result(8, 'c', 3000) }), /fork detected/);
  assert.throws(() => persistTrustedHistoryState({ statePath: path, verification: result(9, 'd', 1000) }), /timestamp rollback detected/);
});
test('fails closed on corrupt state and never updates from an invalid verification', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-trust-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); writeFileSync(path, '{broken');
  assert.throws(() => persistTrustedHistoryState({ statePath: path, verification: result(1) }), /Cannot trust existing state/);
  assert.throws(() => persistTrustedHistoryState({ statePath: path, verification: { ...result(1), valid: false } }), /Only a successful/);
});
test('fails closed when another writer holds the lock without deleting its lock', t => {
  const dir = mkdtempSync(join(tmpdir(), 'zion-trust-state-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); writeFileSync(`${path}.lock`, 'other process');
  assert.throws(() => persistTrustedHistoryState({ statePath: path, verification: result(1) }));
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), 'other process');
});
