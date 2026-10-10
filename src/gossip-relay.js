import { createHash, sign, verify, createPublicKey } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_TTL_MS = 10 * 60_000;
const ALLOWED_TYPES = new Set(['peer-seen', 'peer-expired', 'chunk-available', 'chunk-unavailable']);
const EVENT_FIELDS = new Set(['originId', 'type', 'createdAt', 'ttlMs', 'chunkId', 'peerId']);

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Gossip numbers must be safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported gossip value');
}

function stableBody(event) {
  const body = {};
  for (const key of Object.keys(event)) if (EVENT_FIELDS.has(key)) body[key] = event[key];
  return body;
}

function calculateEventId(body) {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

function validateOriginSignature(event) {
  try {
    if (typeof event.originPublicKeyPem !== 'string' || typeof event.originSignature !== 'string') return false;
    const publicKey = createPublicKey(event.originPublicKeyPem);
    const derivedId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (derivedId !== event.originId) return false;
    return verify(null, Buffer.from(canonical(stableBody(event))), publicKey, Buffer.from(event.originSignature, 'base64'));
  } catch { return false; }
}

function validEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (typeof event.originId !== 'string' || !HASH.test(event.originId) ||
      typeof event.eventId !== 'string' || !HASH.test(event.eventId) ||
      !ALLOWED_TYPES.has(event.type) ||
      !Number.isSafeInteger(event.createdAt) || event.createdAt <= 0 ||
      !Number.isSafeInteger(event.ttlMs) || event.ttlMs <= 0 || event.ttlMs > DEFAULT_MAX_TTL_MS ||
      !Number.isSafeInteger(event.hopsRemaining) || event.hopsRemaining < 0 || event.hopsRemaining > 16 ||
      (event.chunkId !== undefined && (typeof event.chunkId !== 'string' || !HASH.test(event.chunkId))) ||
      (event.peerId !== undefined && (typeof event.peerId !== 'string' || !HASH.test(event.peerId)))) return false;
  const expectedKeys = new Set([...EVENT_FIELDS, 'eventId', 'hopsRemaining', 'originPublicKeyPem', 'originSignature']);
  if (Object.keys(event).some(key => !expectedKeys.has(key))) return false;
  const body = stableBody(event);
  return calculateEventId(body) === event.eventId && validateOriginSignature(event);
}

/**
 * Bounded gossip relay. The origin signs immutable event fields; forwarding nodes
 * may decrement hopsRemaining without being able to forge or alter the event.
 * Gossip is still only a hint: consumers must independently verify peer liveness
 * and the referenced content.
 */
export class GossipRelay {
  constructor({ maxEvents = DEFAULT_MAX_EVENTS, maxTtlMs = DEFAULT_MAX_TTL_MS, now = () => Date.now() } = {}) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1_000_000) throw new RangeError('Invalid maxEvents');
    if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1 || maxTtlMs > DEFAULT_MAX_TTL_MS) throw new RangeError('Invalid maxTtlMs');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.maxEvents = maxEvents;
    this.maxTtlMs = maxTtlMs;
    this.now = now;
    this.seen = new Map();
  }

  create({ identity, type, chunkId, peerId, ttlMs = 60_000, hopsRemaining = 8 } = {}) {
    if (!identity?.privateKey || typeof identity.publicKeyPem !== 'string' || typeof identity.nodeId !== 'string' || !HASH.test(identity.nodeId)) {
      throw new TypeError('A valid origin node identity is required');
    }
    if (!ALLOWED_TYPES.has(type)) throw new TypeError('Unsupported gossip event type');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(hopsRemaining) || hopsRemaining < 0 || hopsRemaining > 16) throw new TypeError('Invalid gossip TTL or hop count');
    const body = { originId: identity.nodeId, type, createdAt: this.now(), ttlMs: Math.min(ttlMs, this.maxTtlMs) };
    if (chunkId !== undefined) body.chunkId = chunkId;
    if (peerId !== undefined) body.peerId = peerId;
    const bytes = Buffer.from(canonical(body));
    const eventId = calculateEventId(body);
    const event = Object.freeze({
      ...body,
      eventId,
      hopsRemaining,
      originPublicKeyPem: identity.publicKeyPem,
      originSignature: sign(null, bytes, identity.privateKey).toString('base64'),
    });
    if (!validEvent(event)) throw new TypeError('Invalid gossip event fields or identity');
    this.accept(event);
    return event;
  }

  accept(event) {
    const now = this.now();
    this.#prune(now);
    if (!validEvent(event) || event.ttlMs > this.maxTtlMs) return { accepted: false, reason: 'invalid-event' };
    if (event.createdAt > now + 30_000 || now - event.createdAt > event.ttlMs) return { accepted: false, reason: 'expired-event' };
    if (this.seen.has(event.eventId)) return { accepted: false, reason: 'duplicate' };
    if (this.seen.size >= this.maxEvents) return { accepted: false, reason: 'capacity' };
    this.seen.set(event.eventId, event.createdAt + event.ttlMs);
    return { accepted: true, forward: event.hopsRemaining > 0 ? Object.freeze({ ...event, hopsRemaining: event.hopsRemaining - 1 }) : null };
  }

  snapshot() {
    this.#prune(this.now());
    return Object.freeze([...this.seen.keys()]);
  }

  #prune(now) {
    for (const [id, expiresAt] of this.seen) if (expiresAt <= now) this.seen.delete(id);
  }
}
