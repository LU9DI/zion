import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommittedStateHarness,
  MemoryAtomicCommittedStateStore,
} from './support/committed-state-harness.js';

const op = (operationId, key, value) => ({ operationId, type: 'SET', key, value });

test('finalizeBlock is deterministic and does not mutate committed state', () => {
  const store = new MemoryAtomicCommittedStateStore();
  const app = new CommittedStateHarness(store);
  const block = { height: 1, transactions: [op('operation-00000001', 'profile.name', 'Zion')] };
  const first = app.finalizeBlock(block);
  const second = app.finalizeBlock(block);
  assert.equal(first.appHash, second.appHash);
  assert.deepEqual(first.results, second.results);
  assert.equal(app.info().lastBlockHeight, 0);
  assert.equal(store.read().data['profile.name'], undefined);
});

test('commit persists state, operation result, and outbox as one modeled snapshot', () => {
  const store = new MemoryAtomicCommittedStateStore();
  const app = new CommittedStateHarness(store);
  const finalized = app.finalizeBlock({
    height: 1,
    transactions: [op('operation-00000002', 'profile.name', 'Zion')],
  });
  const result = app.commit(finalized);
  const recovered = new CommittedStateHarness(store);
  assert.equal(result.status, 'committed');
  assert.deepEqual(recovered.info(), { lastBlockHeight: 1, appHash: finalized.appHash });
  const snapshot = store.read();
  assert.deepEqual(snapshot.data, { 'profile.name': 'Zion' });
  assert.equal(snapshot.operations['operation-00000002'].result.value, 'Zion');
  assert.deepEqual(snapshot.outbox.map(item => item.id), ['operation-00000002']);
  assert.equal(snapshot.outbox[0].delivered, false);
});

test('operation replay is idempotent and does not enqueue a second outbox item', () => {
  const store = new MemoryAtomicCommittedStateStore();
  const app = new CommittedStateHarness(store);
  app.commit(app.finalizeBlock({ height: 1, transactions: [op('operation-00000003', 'k', 'v')] }));
  const replay = app.finalizeBlock({ height: 2, transactions: [op('operation-00000003', 'k', 'v')] });
  assert.equal(replay.results[0].status, 'duplicate');
  app.commit(replay);
  assert.equal(store.read().outbox.length, 1);
  assert.equal(store.read().height, 2);
});

test('reusing an operation ID with different content fails closed', () => {
  const store = new MemoryAtomicCommittedStateStore();
  const app = new CommittedStateHarness(store);
  app.commit(app.finalizeBlock({ height: 1, transactions: [op('operation-00000004', 'k', 'v1')] }));
  assert.throws(
    () => app.finalizeBlock({ height: 2, transactions: [op('operation-00000004', 'k', 'v2')] }),
    { code: 'HARNESS_OPERATION_CONFLICT' },
  );
  assert.equal(store.read().height, 1);
});

test('pre-commit and mid-transaction failures leave the modeled snapshot unchanged', () => {
  for (const failAt of ['before-transaction', 'during-transaction']) {
    const store = new MemoryAtomicCommittedStateStore();
    const app = new CommittedStateHarness(store);
    const before = store.read();
    const finalized = app.finalizeBlock({ height: 1, transactions: [op('operation-00000005', 'k', 'v')] });
    assert.throws(() => app.commit(finalized, { failAt }));
    assert.deepEqual(store.read(), before);
    assert.equal(new CommittedStateHarness(store).info().lastBlockHeight, 0);
  }
});

test('crash after atomic commit is recovered as committed and replay is idempotent', () => {
  const store = new MemoryAtomicCommittedStateStore();
  const app = new CommittedStateHarness(store);
  const finalized = app.finalizeBlock({ height: 1, transactions: [op('operation-00000006', 'k', 'v')] });
  assert.throws(
    () => app.commit(finalized, { failAt: 'after-durable-commit' }),
    { code: 'HARNESS_CRASH_AFTER_COMMIT' },
  );
  const recovered = new CommittedStateHarness(store);
  assert.equal(recovered.info().lastBlockHeight, 1);
  assert.equal(recovered.commit(finalized).status, 'already-committed');
  assert.equal(store.read().outbox.length, 1);
});

test('stale, out-of-order, and modified finalized states are rejected', () => {
  const store = new MemoryAtomicCommittedStateStore();
  const app = new CommittedStateHarness(store);
  const finalized = app.finalizeBlock({ height: 1, transactions: [op('operation-00000007', 'k', 'v')] });
  const modified = { ...finalized, state: { ...finalized.state, data: { k: 'tampered' } } };
  assert.throws(() => app.commit(modified), { code: 'HARNESS_INVALID_FINALIZED_STATE' });
  app.commit(finalized);
  const competing = new CommittedStateHarness(new MemoryAtomicCommittedStateStore())
    .finalizeBlock({ height: 1, transactions: [op('operation-00000070', 'other', 'state')] });
  assert.throws(() => app.commit(competing), { code: 'HARNESS_COMMIT_CONFLICT' });
  assert.throws(
    () => app.finalizeBlock({ height: 3, transactions: [] }),
    { code: 'HARNESS_INVALID_BLOCK' },
  );
});

test('invalid non-canonical values and malformed operations are rejected', () => {
  const app = new CommittedStateHarness();
  assert.throws(
    () => app.finalizeBlock({ height: 1, transactions: [op('operation-00000008', 'k', Number.NaN)] }),
    /safe integers/,
  );
  assert.throws(
    () => app.finalizeBlock({ height: 1, transactions: [{ operationId: 'operation-00000009', type: 'DELETE', key: 'k', value: null }] }),
    /Invalid committed-state harness transaction/,
  );
});
