import test from 'node:test';
import assert from 'node:assert/strict';
import { startOfficialNode } from '../scripts/start-official-node.js';

const env = Object.freeze({
  ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/deployment/official-adapter.mjs',
  ZION_POSTGRES_URL: 'postgres://unit-test.invalid/zion',
});

function poolFixture() {
  const instances = [];
  class FakePool {
    constructor(options) { this.options = options; this.ended = false; instances.push(this); }
    async end() { this.ended = true; }
  }
  return { FakePool, instances };
}

test('official launcher requires an absolute deployment-owned adapter path', async () => {
  let loaded = false;
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env: { ...env, ZION_OFFICIAL_ADAPTER_MODULE: 'relative-adapter.mjs' },
    PoolClass: FakePool,
    loadAdapterModule: async () => { loaded = true; return {}; },
  }), /absolute path/);
  assert.equal(loaded, false);
  assert.equal(instances.length, 0);
});

test('official launcher validates PostgreSQL pool bounds before loading deployment code', async () => {
  let loaded = false;
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env: { ...env, ZION_POSTGRES_POOL_MAX: '101' },
    PoolClass: FakePool,
    loadAdapterModule: async () => { loaded = true; return {}; },
  }), /between 1 and 100/);
  assert.equal(loaded, false);
  assert.equal(instances.length, 0);
});

test('official launcher refuses an adapter module without the explicit dependency factory', async () => {
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: FakePool,
    loadAdapterModule: async specifier => {
      assert.equal(specifier, 'file:///opt/zion/deployment/official-adapter.mjs');
      return {};
    },
  }), /createOfficialNodeDependencies/);
  assert.equal(instances.length, 0);
});

test('official launcher closes the pool when deployment dependencies are incomplete', async () => {
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: FakePool,
    loadAdapterModule: async () => ({
      async createOfficialNodeDependencies({ pool }) {
        assert.equal(pool, instances[0]);
        return { identity: { nodeId: 'untrusted-incomplete-fixture' } };
      },
    }),
  }), /complete IntegrityGuard/);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].options.max, 10);
  assert.equal(instances[0].options.connectionTimeoutMillis, 5000);
  assert.equal(instances[0].ended, true);
});

test('official launcher closes the pool when adapter initialization throws', async () => {
  const { FakePool, instances } = poolFixture();
  await assert.rejects(startOfficialNode({
    env,
    PoolClass: FakePool,
    loadAdapterModule: async () => ({
      async createOfficialNodeDependencies() { throw new Error('adapter initialization failed'); },
    }),
  }), /adapter initialization failed/);
  assert.equal(instances[0].ended, true);
});
