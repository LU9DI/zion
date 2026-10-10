import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialMessageInbox } from '../src/social-message-inbox.js';

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zion-social-inbox-'));
  const filePath = join(dir, 'inbox.json');
  const inbox = new SocialMessageInbox({ filePath, ...options });
  await inbox.init();
  return { dir, filePath, inbox };
}
function envelope(id, recipientId = 'bob', senderId = 'alice', createdAt = 1_000) {
  return { version: 1, id, senderId, recipientId, createdAt, ciphertext: 'ciphertext-only', signature: 'signature' };
}

test('encrypted envelope persists across inbox restart and is scoped to recipient', async t => {
  let now = 1_000;
  const f = await fixture({ now: () => now, ttlMs: 10_000 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const result = await f.inbox.enqueue(envelope('msg-1'));
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  const saved = JSON.parse(await readFile(f.filePath, 'utf8'));
  assert.equal(JSON.stringify(saved).includes('plaintext'), false);
  const restarted = new SocialMessageInbox({ filePath: f.filePath, now: () => now, ttlMs: 10_000 });
  assert.equal((await restarted.list('bob')).length, 1);
  assert.equal((await restarted.list('mallory')).length, 0);
});

test('enqueue is idempotent by sender and message id', async t => {
  const f = await fixture({ now: () => 1_000, ttlMs: 10_000 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal((await f.inbox.enqueue(envelope('same'))).duplicate, false);
  assert.equal((await f.inbox.enqueue(envelope('same'))).duplicate, true);
  assert.equal((await f.inbox.stats()).messages, 1);
});

test('recipient quota and global quota reject overflow without losing queued messages', async t => {
  const f = await fixture({ now: () => 1_000, ttlMs: 10_000, maxMessages: 2, maxPerRecipient: 1 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.inbox.enqueue(envelope('one'));
  await assert.rejects(f.inbox.enqueue(envelope('two')), /recipient inbox capacity/);
  await f.inbox.enqueue(envelope('three', 'carol'));
  await assert.rejects(f.inbox.enqueue(envelope('four', 'dave')), /inbox capacity/);
  assert.equal((await f.inbox.stats()).messages, 2);
});

test('acknowledgement removes only matching recipient queue entries', async t => {
  const f = await fixture({ now: () => 1_000, ttlMs: 10_000 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.inbox.enqueue(envelope('one'));
  await f.inbox.enqueue(envelope('two', 'carol'));
  const [entry] = await f.inbox.list('bob');
  assert.deepEqual(await f.inbox.acknowledge('bob', [entry.queueId]), { acknowledged: 1 });
  assert.equal((await f.inbox.list('bob')).length, 0);
  assert.equal((await f.inbox.list('carol')).length, 1);
});

test('invalid, oversized, and stale envelopes are rejected', async t => {
  const f = await fixture({ now: () => 20_000, ttlMs: 10_000 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await assert.rejects(f.inbox.enqueue(envelope('old', 'bob', 'alice', 1_000)), /timestamp/);
  await assert.rejects(f.inbox.enqueue({ ...envelope('bad'), version: 2 }), /version/);
  await assert.rejects(f.inbox.enqueue(envelope('huge', 'bob', 'alice', 20_000) && { ...envelope('huge', 'bob', 'alice', 20_000), ciphertext: 'x'.repeat(92_000), signature: 's'.repeat(8_000) }), /maximum size/);
});

test('expired records are pruned on restart rather than poisoning the whole inbox', async t => {
  let now = 1_000;
  const f = await fixture({ now: () => now, ttlMs: 100 });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  await f.inbox.enqueue(envelope('expiring'));
  now = 2_000;
  const restarted = new SocialMessageInbox({ filePath: f.filePath, now: () => now, ttlMs: 100 });
  assert.equal((await restarted.list('bob')).length, 0);
});
