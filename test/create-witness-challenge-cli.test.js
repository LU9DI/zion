import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NotificationRecoveryAuditAnchor } from '../src/notification-recovery-audit-anchor.js';

function makeHistory() {
  const root = mkdtempSync(join(tmpdir(), 'zion-witness-challenge-cli-'));
  const registryPath = join(root, 'registry.json');
  const state = { schemaVersion: 1, revision: 1, keys: {}, events: [] };
  state.stateSha256 = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  writeFileSync(registryPath, JSON.stringify(state));
  const keys = generateKeyPairSync('ed25519');
  const checkpoint = NotificationRecoveryAuditAnchor.createCheckpoint({ registryPath, signerKeyId: 'challenge-cli-test', privateKey: keys.privateKey, issuedAt: 1_800_000_000_000 });
  const historyPath = join(root, 'history.json');
  writeFileSync(historyPath, JSON.stringify([checkpoint]));
  return { historyPath, checkpoint };
}

test('challenge CLI emits a fresh nonce bound to the history head', () => {
  const { historyPath, checkpoint } = makeHistory();
  const run = spawnSync(process.execPath, ['scripts/create-witness-challenge.js', historyPath, '--ttl-ms', '10000'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const challenge = JSON.parse(run.stdout);
  assert.match(challenge.nonce, /^[a-f0-9]{64}$/);
  assert.equal(challenge.expectedHistoryHeadSha256, NotificationRecoveryAuditAnchor.checkpointSha256(checkpoint));
  assert.equal(challenge.expiresAt - challenge.issuedAt, 10_000);
});

test('challenge CLI rejects invalid TTL and empty history', () => {
  const { historyPath } = makeHistory();
  const invalidTtl = spawnSync(process.execPath, ['scripts/create-witness-challenge.js', historyPath, '--ttl-ms', '0'], { encoding: 'utf8' });
  assert.notEqual(invalidTtl.status, 0);
  const root = mkdtempSync(join(tmpdir(), 'zion-witness-empty-history-'));
  const emptyHistory = join(root, 'history.json');
  writeFileSync(emptyHistory, '[]');
  const empty = spawnSync(process.execPath, ['scripts/create-witness-challenge.js', emptyHistory], { encoding: 'utf8' });
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /non-empty array/);
});
