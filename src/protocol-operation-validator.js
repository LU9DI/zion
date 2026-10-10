const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const TYPES = new Set(['PING', 'PONG', 'STORE_CHUNK', 'GET_CHUNK', 'CHUNK_DATA', 'MANIFEST', 'STORE_REQUEST', 'STORE_RECEIPT', 'STORE_REJECTED']);

function int(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function text(value, max = 256) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}
function validRequest(r, now, limits) {
  return !!r && r.type === 'STORE_REQUEST' && HEX32.test(r.requestId ?? '') && HEX64.test(r.chunkId ?? '') &&
    HEX64.test(r.targetNodeId ?? '') && int(r.bytes, 33, 64 * 1024 * 1024) && int(r.createdAt, 0, now + limits.maxClockSkewMs) &&
    int(r.expiresAt, r.createdAt, r.createdAt + limits.maxTtlMs) && r.expiresAt >= now;
}

/** Protocol-level shape checks. Domain handlers must still verify authorization, state and persistence. */
export function validateProtocolOperation(payload, { genesis, now = Date.now() } = {}) {
  if (!genesis || !payload || typeof payload !== 'object' || Array.isArray(payload) || !TYPES.has(payload.type)) return { ok: false, reason: 'unsupported-operation' };
  const limits = { ...genesis.limits, maxClockSkewMs: genesis.replay.maxClockSkewMs };
  const fail = reason => ({ ok: false, reason });
  switch (payload.type) {
    case 'PING': case 'PONG':
      return text(payload.nonce, 128) ? { ok: true } : fail('invalid-ping-nonce');
    case 'GET_CHUNK':
      return HEX64.test(payload.chunkId ?? '') && HEX32.test(payload.requestId ?? '') ? { ok: true } : fail('invalid-get-chunk');
    case 'STORE_CHUNK': case 'CHUNK_DATA': {
      if (!HEX32.test(payload.transferId ?? '') || !HEX64.test(payload.chunkId ?? '') ||
        !int(payload.totalBytes, 33, 64 * 1024 * 1024) || !int(payload.partCount, 1, 65536) ||
        !int(payload.partIndex, 0, payload.partCount - 1) || !text(payload.data, Math.ceil(limits.maxMessageBytes * 4 / 3)) || !canonicalBase64(payload.data)) return fail('invalid-chunk-segment');
      if (payload.type === 'CHUNK_DATA' && !HEX32.test(payload.requestId ?? '')) return fail('invalid-chunk-request-id');
      if (payload.type === 'STORE_CHUNK' && payload.partIndex === 0 && !validRequest(payload.request, now, limits)) return fail('invalid-store-request');
      if (payload.type === 'STORE_CHUNK' && payload.request !== undefined && payload.partIndex !== 0) return fail('unexpected-store-request');
      return { ok: true };
    }
    case 'STORE_REQUEST':
      return validRequest(payload, now, limits) ? { ok: true } : fail('invalid-store-request');
    case 'STORE_RECEIPT':
      return HEX32.test(payload.requestId ?? '') && HEX64.test(payload.chunkId ?? '') && int(payload.storedBytes, 1, 64 * 1024 * 1024) && int(payload.storedAt, 0, now + limits.maxClockSkewMs) ? { ok: true } : fail('invalid-store-receipt');
    case 'STORE_REJECTED':
      return (payload.requestId === undefined || HEX32.test(payload.requestId)) && HEX64.test(payload.chunkId ?? '') &&
        ['CAPACITY_EXHAUSTED', 'FAIR_USE_LIMIT'].includes(payload.code) && int(payload.availableBytes, 0, Number.MAX_SAFE_INTEGER) ? { ok: true } : fail('invalid-store-rejected');
    case 'MANIFEST':
      return payload.manifest && typeof payload.manifest === 'object' && !Array.isArray(payload.manifest) ? { ok: true } : fail('invalid-manifest-envelope');
    default: return fail('unsupported-operation');
  }
}
