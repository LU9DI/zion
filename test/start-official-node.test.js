import test from 'node:test';
import assert from 'node:assert/strict';
import { startOfficialNode } from '../scripts/start-official-node.js';

test('official launcher rejects a missing deployment adapter before loading modules', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: { ZION_POSTGRES_URL: 'postgres://unused' },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /ZION_OFFICIAL_ADAPTER_MODULE/,
  );
  assert.equal(loaded, false);
});

test('official launcher requires a PostgreSQL URL before loading deployment code', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: { ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs' },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /ZION_POSTGRES_URL/,
  );
  assert.equal(loaded, false);
});

test('official launcher rejects invalid pool bounds before loading deployment code', async () => {
  let loaded = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
        ZION_POSTGRES_POOL_MAX: '101',
      },
      loadAdapterModule: async () => { loaded = true; return {}; },
    }),
    /ZION_POSTGRES_POOL_MAX/,
  );
  assert.equal(loaded, false);
});


test('official launcher closes the PostgreSQL pool when adapter validation fails', async () => {
  let poolClosed = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
      },
      loadAdapterModule: async () => ({
        createPool: async () => ({
          connect: async () => ({}),
          end: async () => { poolClosed = true; },
        }),
        createOfficialNodeDependencies: async () => ({}),
      }),
    }),
    /complete IntegrityGuard/,
  );
  assert.equal(poolClosed, true);
});

test('official launcher closes a partially invalid PostgreSQL pool', async () => {
  let poolClosed = false;
  await assert.rejects(
    startOfficialNode({
      env: {
        ZION_OFFICIAL_ADAPTER_MODULE: '/opt/zion/adapter.mjs',
        ZION_POSTGRES_URL: 'postgres://unused',
      },
      loadAdapterModule: async () => ({
        createPool: async () => ({
          end: async () => { poolClosed = true; },
        }),
        createOfficialNodeDependencies: async () => ({}),
      }),
    }),
    /pg-compatible pool/,
  );
  assert.equal(poolClosed, true);
});
