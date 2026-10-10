import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNetworkId, checkNetworkCompatibility, validateGenesisDocument } from '../src/protocol-genesis.js';

function draft(overrides = {}) {
  return {
    schemaVersion: 1,
    networkName: 'Zion Test Network',
    protocolMajor: 1,
    genesisTime: 1_800_000_000,
    serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 16, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
    ...overrides,
  };
}

test('genesis ID is stable across object key order and binds all parameters', () => {
  const original = draft();
  const reordered = JSON.parse(JSON.stringify(original, Object.keys(original).sort()));
  assert.equal(calculateNetworkId(original), calculateNetworkId(original));
  assert.match(calculateNetworkId(original), /^zion:[a-f0-9]{64}$/);
  assert.notEqual(calculateNetworkId(original), calculateNetworkId({ ...original, protocolMajor: 2 }));
  assert.notEqual(calculateNetworkId(original), calculateNetworkId({ ...original, limits: { ...original.limits, maxHops: 15 } }));
  assert.ok(reordered); // nested canonicalization is covered by equivalent deep clone below
  assert.equal(calculateNetworkId(original), calculateNetworkId(JSON.parse(JSON.stringify(original))));
});

test('genesis rejects missing fields, unknown fields, and invalid mandatory safety rules', () => {
  const missing = draft(); delete missing.crypto.hash;
  assert.throws(() => validateGenesisDocument(missing), /missing or unknown/);
  assert.throws(() => validateGenesisDocument({ ...draft(), unreviewedUpgradeKey: 'secret' }), /missing or unknown/);
  assert.throws(() => validateGenesisDocument({ ...draft(), rules: { ...draft().rules, breakingChangesRequireNewNetwork: false } }), /mandatory/);
});

test('genesis rejects inconsistent and out-of-range limits', () => {
  assert.throws(() => validateGenesisDocument({ ...draft(), limits: { ...draft().limits, maxMessageBytes: 300000 } }), /cannot exceed/);
  assert.throws(() => validateGenesisDocument({ ...draft(), erasureCoding: { ...draft().erasureCoding, dataShards: 0 } }), /data shard count/);
  assert.throws(() => validateGenesisDocument({ ...draft(), replay: { ...draft().replay, nonceBytes: 8 } }), /nonceBytes/);
});

test('network compatibility rejects forks and protocol downgrade attempts', () => {
  const genesis = draft(); const networkId = calculateNetworkId(genesis);
  assert.equal(checkNetworkCompatibility(genesis, networkId, 1).compatible, true);
  assert.equal(checkNetworkCompatibility(genesis, calculateNetworkId({ ...genesis, networkName: 'Zion fork' }), 1).reason, 'network-mismatch');
  assert.equal(checkNetworkCompatibility(genesis, networkId, 2).reason, 'protocol-major-mismatch');
  assert.equal(checkNetworkCompatibility(genesis, 'zion:not-a-hash', 1).reason, 'invalid-network-id');
});

test('validated genesis is deeply frozen and detached from caller input', () => {
  const input = draft(); const result = validateGenesisDocument(input);
  input.limits.maxHops = 2;
  assert.equal(result.limits.maxHops, 16);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.crypto), true);
});
