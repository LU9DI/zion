import { createHash } from 'node:crypto';

const ROOT_KEYS = new Set(['schemaVersion', 'networkName', 'protocolMajor', 'genesisTime', 'serialization', 'crypto', 'contentAddress', 'erasureCoding', 'limits', 'replay', 'rules']);
const OBJECT_KEYS = Object.freeze({
  crypto: new Set(['identity', 'signature', 'hash', 'aead']),
  contentAddress: new Set(['algorithm', 'encoding']),
  erasureCoding: new Set(['algorithm', 'dataShards', 'parityShards']),
  limits: new Set(['maxFrameBytes', 'maxMessageBytes', 'maxTtlMs', 'maxHops']),
  replay: new Set(['maxClockSkewMs', 'nonceBytes', 'retentionMs']),
  rules: new Set(['gossipIsDiscoveryOnly', 'localResourceLimitsAreAuthoritative', 'breakingChangesRequireNewNetwork']),
});

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Genesis numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Genesis contains an unsupported value');
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some(key => !allowed.has(key))) throw new TypeError(`${label} has missing or unknown fields`);
}

function assertString(value, label, max = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) throw new TypeError(`Invalid ${label}`);
}

function assertInt(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${label}`);
}

/**
 * Validate and normalize a proposed genesis document. This deliberately does not
 * ship a default NetworkID: the canonical parameters must be reviewed first.
 */
export function validateGenesisDocument(input) {
  assertExactKeys(input, ROOT_KEYS, 'Genesis');
  if (input.schemaVersion !== 1) throw new TypeError('Unsupported genesis schema version');
  assertString(input.networkName, 'network name', 64);
  assertInt(input.protocolMajor, 'protocol major version', 1, 65535);
  assertInt(input.genesisTime, 'genesis time', 0, Number.MAX_SAFE_INTEGER);
  assertString(input.serialization, 'serialization', 64);
  for (const key of Object.keys(OBJECT_KEYS)) assertExactKeys(input[key], OBJECT_KEYS[key], `Genesis ${key}`);
  for (const [key, value] of Object.entries(input.crypto)) assertString(value, `crypto.${key}`, 64);
  for (const [key, value] of Object.entries(input.contentAddress)) assertString(value, `contentAddress.${key}`, 64);
  assertString(input.erasureCoding.algorithm, 'erasure coding algorithm', 64);
  assertInt(input.erasureCoding.dataShards, 'data shard count', 1, 65535);
  assertInt(input.erasureCoding.parityShards, 'parity shard count', 0, 65535);
  for (const [key, value] of Object.entries(input.limits)) {
    const ranges = { maxFrameBytes: [256, 16 * 1024 * 1024], maxMessageBytes: [256, 16 * 1024 * 1024], maxTtlMs: [1, 7 * 24 * 60 * 60 * 1000], maxHops: [0, 255] };
    assertInt(value, `limits.${key}`, ...ranges[key]);
  }
  for (const [key, value] of Object.entries(input.replay)) {
    const ranges = { maxClockSkewMs: [0, 24 * 60 * 60 * 1000], nonceBytes: [16, 64], retentionMs: [1, 7 * 24 * 60 * 60 * 1000] };
    assertInt(value, `replay.${key}`, ...ranges[key]);
  }
  for (const [key, value] of Object.entries(input.rules)) {
    if (typeof value !== 'boolean') throw new TypeError(`Invalid rules.${key}`);
  }
  if (!input.rules.gossipIsDiscoveryOnly || !input.rules.localResourceLimitsAreAuthoritative || !input.rules.breakingChangesRequireNewNetwork) {
    throw new TypeError('Genesis violates a mandatory Zion safety/compatibility rule');
  }
  if (input.erasureCoding.dataShards + input.erasureCoding.parityShards > 65535) throw new TypeError('Too many total erasure shards');
  if (input.limits.maxMessageBytes > input.limits.maxFrameBytes) throw new TypeError('Message limit cannot exceed frame limit');
  // Canonicalize and clone through JSON so callers cannot mutate the returned tree.
  const normalized = JSON.parse(canonical(input));
  return deepFreeze(normalized);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalGenesisBytes(input) {
  return Buffer.from(canonical(validateGenesisDocument(input)), 'utf8');
}

export function calculateNetworkId(input) {
  const bytes = canonicalGenesisBytes(input);
  return `zion:${createHash('sha256').update('ZION-GENESIS-V1\0').update(bytes).digest('hex')}`;
}

/** Compare local and remote immutable network commitments; no downgrade path. */
export function checkNetworkCompatibility(localGenesis, remoteNetworkId, remoteProtocolMajor) {
  const local = validateGenesisDocument(localGenesis);
  if (typeof remoteNetworkId !== 'string' || !/^zion:[a-f0-9]{64}$/.test(remoteNetworkId)) return { compatible: false, reason: 'invalid-network-id' };
  if (!Number.isSafeInteger(remoteProtocolMajor) || remoteProtocolMajor < 1) return { compatible: false, reason: 'invalid-protocol-version' };
  const expected = calculateNetworkId(local);
  if (remoteNetworkId !== expected) return { compatible: false, reason: 'network-mismatch', expectedNetworkId: expected };
  if (remoteProtocolMajor !== local.protocolMajor) return { compatible: false, reason: 'protocol-major-mismatch', expectedProtocolMajor: local.protocolMajor };
  return { compatible: true, networkId: expected };
}
