import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProtocolOperation } from '../src/protocol-operation-validator.js';

const genesis = {
  protocolMajor: 1,
  limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
  replay: { maxClockSkewMs: 120000, nonceBytes: 32, retentionMs: 120000 },
};

test('official operation validator accepts a well-formed ping and rejects unknown types', () => {
  assert.equal(validateProtocolOperation({ type: 'PING', nonce: 'n1' }, { genesis }).ok, true);
  assert.equal(validateProtocolOperation({ type: 'RUN_CODE', code: 'x' }, { genesis }).reason, 'unsupported-operation');
});

test('official operation validator rejects an invalid clock before timestamp comparisons', () => {
  const request = { type: 'STORE_REQUEST', requestId: 'a'.repeat(32), chunkId: 'b'.repeat(64), targetNodeId: 'c'.repeat(64), bytes: 1024, createdAt: 1, expiresAt: 1000 };
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(validateProtocolOperation({ type: 'PING', nonce: 'n1' }, { genesis, now }).reason, 'invalid-clock');
    assert.equal(validateProtocolOperation(request, { genesis, now }).reason, 'invalid-clock');
  }
});

test('official operation validator rejects malformed chunk segments before handlers see them', () => {
  const bad = { type: 'CHUNK_DATA', transferId: 'a'.repeat(32), requestId: 'b'.repeat(32), chunkId: 'c'.repeat(64), totalBytes: 33, partIndex: 0, partCount: 1, data: 'YQ==' };
  assert.equal(validateProtocolOperation(bad, { genesis }).ok, true, 'canonical base64 is structurally valid; final digest is checked by storage');
  assert.equal(validateProtocolOperation({ ...bad, data: 'not base64!' }, { genesis }).reason, 'invalid-chunk-segment');
  assert.equal(validateProtocolOperation({ ...bad, partIndex: 1 }, { genesis }).reason, 'invalid-chunk-segment');
  assert.equal(validateProtocolOperation({ ...bad, requestId: 'bad' }, { genesis }).reason, 'invalid-chunk-request-id');
});

test('official operation validator validates signed receipt payload shape', () => {
  const valid = { type: 'STORE_RECEIPT', requestId: 'a'.repeat(32), chunkId: 'b'.repeat(64), storedBytes: 1024, storedAt: Date.now() };
  assert.equal(validateProtocolOperation(valid, { genesis }).ok, true);
  assert.equal(validateProtocolOperation({ ...valid, storedBytes: -1 }, { genesis }).reason, 'invalid-store-receipt');
});
