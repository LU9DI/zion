import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update('ZION-COMMITTED-STATE-HARNESS-V1\\0').update(canonical(value)).digest('hex');

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Harness values must use safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('Harness values must be canonical JSON');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function statePayload(state) {
  return {
    schemaVersion: 1,
    height: state.height,
    data: state.data,
    operations: state.operations,
    outbox: state.outbox,
  };
}

function withRoot(state) {
  const payload = statePayload(state);
  return Object.freeze({ ...payload, appHash: hash(payload) });
}

function validateTransaction(tx) {
  if (!tx || typeof tx !== 'object' || Array.isArray(tx) ||
      Object.keys(tx).sort().join(',') !== 'key,operationId,type,value' ||
      tx.type !== 'SET' ||
      typeof tx.operationId !== 'string' || !/^[a-zA-Z0-9._:-]{16,128}$/.test(tx.operationId) ||
      typeof tx.key !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(tx.key)) {
    throw new TypeError('Invalid committed-state harness transaction');
  }
  canonical(tx.value);
  return Object.freeze({ operationId: tx.operationId, type: tx.type, key: tx.key, value: clone(tx.value) });
}

/**
 * Test-only atomic storage model. A successful commit replaces the complete
 * snapshot in one synchronous assignment. It does not model filesystem, WAL,
 * power-loss, database, or hardware durability.
 */
export class MemoryAtomicCommittedStateStore {
  constructor(initialState = null) {
    this.snapshot = initialState ? clone(initialState) : withRoot({
      schemaVersion: 1, height: 0, data: {}, operations: {}, outbox: [],
    });
  }

  read() {
    return clone(this.snapshot);
  }

  commit(expectedHeight, nextState, { failAt } = {}) {
    if (failAt === 'before-transaction') throw Object.assign(new Error('Injected failure before transaction'), { code: 'HARNESS_CRASH_BEFORE_TRANSACTION' });
    if (expectedHeight !== this.snapshot.height + 1 || nextState.height !== expectedHeight) {
      throw Object.assign(new Error('Committed-state height conflict'), { code: 'HARNESS_HEIGHT_CONFLICT' });
    }
    const staged = clone(nextState);
    if (failAt === 'during-transaction') {
      staged.data.__partial_write_probe__ = true;
      throw Object.assign(new Error('Injected failure during transaction'), { code: 'HARNESS_CRASH_DURING_TRANSACTION' });
    }
    this.snapshot = staged;
    if (failAt === 'after-durable-commit') {
      throw Object.assign(new Error('Injected process crash after atomic commit'), { code: 'HARNESS_CRASH_AFTER_COMMIT' });
    }
    return this.read();
  }
}

/**
 * Deterministic state-transition model for tests only. It is not an ABCI app,
 * consensus implementation, or production persistence adapter.
 */
export class CommittedStateHarness {
  constructor(store = new MemoryAtomicCommittedStateStore()) {
    if (!store || typeof store.read !== 'function' || typeof store.commit !== 'function') {
      throw new TypeError('A committed-state store with read and commit methods is required');
    }
    this.store = store;
  }

  info() {
    const state = this.store.read();
    const expected = withRoot(state);
    if (state.appHash !== expected.appHash) {
      throw Object.assign(new Error('Committed state root mismatch'), { code: 'HARNESS_STATE_ROOT_MISMATCH' });
    }
    return Object.freeze({ lastBlockHeight: state.height, appHash: state.appHash });
  }

  finalizeBlock({ height, transactions }) {
    const committed = this.store.read();
    if (!Number.isSafeInteger(height) || height !== committed.height + 1 || !Array.isArray(transactions)) {
      throw Object.assign(new Error('Block height must extend the committed state by exactly one'), { code: 'HARNESS_INVALID_BLOCK' });
    }
    const data = clone(committed.data);
    const operations = clone(committed.operations);
    const outbox = clone(committed.outbox);
    const results = [];
    for (const input of transactions) {
      const tx = validateTransaction(input);
      const requestHash = hash(tx);
      const previous = operations[tx.operationId];
      if (previous) {
        if (previous.requestHash !== requestHash) {
          throw Object.assign(new Error('Operation ID was reused with different content'), { code: 'HARNESS_OPERATION_CONFLICT' });
        }
        results.push({ operationId: tx.operationId, status: 'duplicate', value: clone(previous.result) });
        continue;
      }
      data[tx.key] = clone(tx.value);
      const result = { key: tx.key, value: clone(tx.value) };
      operations[tx.operationId] = { requestHash, result };
      outbox.push({
        id: tx.operationId,
        type: 'STATE_UPDATED',
        payload: { key: tx.key, value: clone(tx.value) },
        delivered: false,
      });
      results.push({ operationId: tx.operationId, status: 'applied', value: clone(result) });
    }
    const next = withRoot({ schemaVersion: 1, height, data, operations, outbox });
    return Object.freeze({
      baseHeight: committed.height,
      height,
      appHash: next.appHash,
      state: next,
      results: Object.freeze(results),
    });
  }

  commit(finalized, options = {}) {
    if (!finalized || !finalized.state || finalized.height !== finalized.state.height ||
        finalized.appHash !== finalized.state.appHash ||
        finalized.appHash !== withRoot(finalized.state).appHash) {
      throw Object.assign(new Error('Invalid or modified finalized state'), { code: 'HARNESS_INVALID_FINALIZED_STATE' });
    }
    const current = this.store.read();
    if (finalized.height === current.height) {
      if (finalized.appHash === current.appHash) return Object.freeze({ status: 'already-committed', ...this.info() });
      throw Object.assign(new Error('Conflicting state at an already committed height'), { code: 'HARNESS_COMMIT_CONFLICT' });
    }
    if (finalized.baseHeight !== current.height || finalized.height !== current.height + 1) {
      throw Object.assign(new Error('Finalized state is stale or out of order'), { code: 'HARNESS_STALE_FINALIZATION' });
    }
    const saved = this.store.commit(finalized.height, finalized.state, options);
    return Object.freeze({ status: 'committed', lastBlockHeight: saved.height, appHash: saved.appHash });
  }
}
