import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAuditStateStore } from '../src/storage-audit-state-store.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'zion-audit-state-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  return join(dir, 'nested', 'audit-state.json');
}
test('durable audit state round-trips through an atomic snapshot', t => {
  const path = fixture(t), store = new FileStorageAuditStateStore(path);
  assert.deepEqual(store.load(), { pending:[], consumed:[] });
  const state = { pending:[{ id:'a'.repeat(32), peerNodeId:'b'.repeat(64), expiresAt:123 }], consumed:[['c'.repeat(32),456]] };
  store.save(state);
  assert.deepEqual(new FileStorageAuditStateStore(path).load(), state);
});
test('rejects corrupted snapshots instead of silently resetting replay state', t => {
  const path = fixture(t), store = new FileStorageAuditStateStore(path);
  store.save({ pending:[], consumed:[] });
  writeFileSync(path, '{"version":1,"state":{"pending":[],"consumed":[]},"checksum":"bad"}');
  assert.throws(() => store.load(), { code:'ZION_AUDIT_STATE_CORRUPT' });
});
test('rejects oversized snapshots on read and write', t => {
  const path = fixture(t), store = new FileStorageAuditStateStore(path, { maxBytes:1024 });
  assert.throws(() => store.save({ pending:[{ data:'x'.repeat(2000) }], consumed:[] }), { code:'ZION_AUDIT_STATE_TOO_LARGE' });
  writeFileSync(path, 'x'.repeat(1025));
  assert.throws(() => store.load(), { code:'ZION_AUDIT_STATE_TOO_LARGE' });
});
