import { generateKeyPairSync, sign, verify, randomBytes, createHash, createPublicKey } from 'node:crypto';

const MAX_MESSAGE_BYTES = 256 * 1024;
const canonical = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are forbidden');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Only plain objects are allowed');
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported protocol value');
};

export function createNodeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const nodeId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return Object.freeze({ nodeId, publicKeyPem, privateKey });
}

export function signPeerMessage(identity, payload, { now = Date.now(), nonce = randomBytes(16).toString('hex') } = {}) {
  if (!identity?.privateKey || !/^[a-f0-9]{64}$/.test(identity.nodeId)) throw new TypeError('Invalid node identity');
  const body = { version: 1, nodeId: identity.nodeId, timestamp: now, nonce, payload };
  const bytes = Buffer.from(canonical(body));
  if (bytes.length > MAX_MESSAGE_BYTES) throw new RangeError('Protocol message too large');
  const signature = sign(null, bytes, identity.privateKey).toString('base64');
  return Object.freeze({ ...body, publicKeyPem: identity.publicKeyPem, signature });
}

/** Stateless signature/schema validation; freshness and replay checks are separate. */
export function verifyPeerMessage(message, { now = Date.now(), maxClockSkewMs = 120_000, maxBytes = MAX_MESSAGE_BYTES } = {}) {
  try {
    if (!Number.isFinite(now)) return { ok: false, reason: 'invalid-clock' };
    // Invalid verification policy must not silently disable freshness or size checks.
    if (!Number.isFinite(maxClockSkewMs) || maxClockSkewMs < 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      return { ok: false, reason: 'invalid-verification-options' };
    }
    if (!message || message.version !== 1 || typeof message.nodeId !== 'string' || !/^[a-f0-9]{64}$/.test(message.nodeId)) return { ok: false, reason: 'invalid-envelope' };
    if (typeof message.timestamp !== 'number' || !Number.isSafeInteger(message.timestamp) || Math.abs(now - message.timestamp) > maxClockSkewMs) return { ok: false, reason: 'stale-timestamp' };
    if (typeof message.nonce !== 'string' || !/^[a-f0-9]{32,128}$/.test(message.nonce)) return { ok: false, reason: 'invalid-nonce' };
    if (typeof message.publicKeyPem !== 'string' || typeof message.signature !== 'string' || !message.payload || typeof message.payload !== 'object') return { ok: false, reason: 'invalid-envelope' };
    const body = { version: message.version, nodeId: message.nodeId, timestamp: message.timestamp, nonce: message.nonce, payload: message.payload };
    const bytes = Buffer.from(canonical(body));
    if (bytes.length > maxBytes) return { ok: false, reason: 'message-too-large' };
    const publicKey = createPublicKey(message.publicKeyPem);
    const derivedId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (derivedId !== message.nodeId) return { ok: false, reason: 'identity-mismatch' };
    if (!verify(null, bytes, publicKey, Buffer.from(message.signature, 'base64'))) return { ok: false, reason: 'bad-signature' };
    return { ok: true, nodeId: derivedId, payload: message.payload };
  } catch { return { ok: false, reason: 'malformed-message' }; }
}

/** Bounded replay cache. Expired entries are pruned on every acceptance. */
export class ReplayGuard {
  constructor({ ttlMs = 120_000, maxEntries = 100_000 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid replay guard limits');
    this.ttlMs = ttlMs; this.maxEntries = maxEntries; this.seen = new Map(); this.expiryHeap = [];
  }
  #pushExpiry(entry) {
    const heap = this.expiryHeap; heap.push(entry);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (heap[parent].expires <= entry.expires) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = entry;
  }
  #popExpiry() {
    const heap = this.expiryHeap;
    const first = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1; const right = left + 1;
        if (left >= heap.length) break;
        const child = right < heap.length && heap[right].expires < heap[left].expires ? right : left;
        if (heap[child].expires >= last.expires) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = last;
    }
    return first;
  }
  #prune(now) {
    while (this.expiryHeap.length && this.expiryHeap[0].expires <= now) {
      const { key, expires } = this.#popExpiry();
      if (this.seen.get(key) === expires) this.seen.delete(key);
    }
  }
  /**
   * Membership check for an already-accepted message. Never inserts, never consumes
   * capacity and never mutates the cache. Callers use it to reject a duplicate before
   * spending shared per-identity budgets on it: a captured signed frame can be replayed
   * from fresh sockets, so charging the victim's bucket would otherwise let a third
   * party drain an honest peer's tokens. A stale entry that was not pruned yet can only
   * match the same (nodeId, nonce) pair, which is itself either the original message or
   * a replay, so returning true early stays fail-closed.
   */
  has(message) {
    if (!message || typeof message.nodeId !== 'string' || typeof message.nonce !== 'string') return false;
    return this.seen.has(`${message.nodeId}:${message.nonce}`);
  }
  /**
   * Roll back a just-accepted envelope when downstream admission fails. This is
   * intentionally exact-key and only removes the current entry, never a newer one.
   * Stale heap nodes are ignored by #prune; compact periodically to keep rollback
   * churn bounded even when callers repeatedly reserve and release unique frames.
   */
  release(message) {
    if (!message || typeof message.nodeId !== 'string' || typeof message.nonce !== 'string') return false;
    const key = `${message.nodeId}:${message.nonce}`;
    if (!this.seen.has(key)) return false;
    this.seen.delete(key);
    if (this.expiryHeap.length > this.maxEntries * 2) {
      const entries = [...this.seen].map(([activeKey, expires]) => ({ key: activeKey, expires }));
      this.expiryHeap = [];
      for (const entry of entries) this.#pushExpiry(entry);
    }
    return true;
  }
  accept(message, now = Date.now()) {
    // Replay expiry arithmetic must remain representable. Huge but finite injected
    // clocks can overflow `now + ttlMs` to Infinity, pinning entries forever.
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + this.ttlMs)) return false;
    this.#prune(now);
    if (!message || typeof message.nodeId !== 'string' || typeof message.nonce !== 'string') return false;
    const key = `${message.nodeId}:${message.nonce}`;
    if (this.seen.has(key) || this.seen.size >= this.maxEntries) return false;
    const expires = now + this.ttlMs;
    this.seen.set(key, expires); this.#pushExpiry({ key, expires }); return true;
  }
}

/** Per-peer token bucket for admission control; not a substitute for network-wide DDoS protection. */
export class PeerRateLimiter {
  constructor({ capacity = 20, refillPerSecond = 5, now = () => Date.now(), maxPeers = 10_000, idleTtlMs = 300_000 } = {}) {
    if (!Number.isFinite(capacity) || capacity < 1 || !Number.isFinite(refillPerSecond) || refillPerSecond < 0 || !Number.isSafeInteger(maxPeers) || maxPeers < 1 || !Number.isSafeInteger(idleTtlMs) || idleTtlMs < 1) throw new RangeError('Invalid rate limits');
    this.capacity = capacity; this.refillPerMs = refillPerSecond / 1000; this.now = now; this.maxPeers = maxPeers; this.idleTtlMs = idleTtlMs; this.buckets = new Map();
  }
  /** Milliseconds until `cost` tokens are available for this peer (0 = now, Infinity = never refills). Does not consume. */
  retryAfterMs(peerId, cost = 1) {
    if (typeof peerId !== 'string' || !peerId || !Number.isFinite(cost) || cost <= 0 || cost > this.capacity) return Infinity;
    const bucket = this.buckets.get(peerId);
    if (!bucket) return 0;
    if (this.refillPerMs <= 0) return Infinity;
    const time = this.now();
    if (!Number.isFinite(time) || time < bucket.at) return Infinity;
    const tokens = Math.min(this.capacity, bucket.tokens + (time - bucket.at) * this.refillPerMs);
    return tokens >= cost ? 0 : Math.ceil((cost - tokens) / this.refillPerMs);
  }
  /** Remove per-peer state when its identity is no longer active (e.g. a closed socket). */
  forget(peerId) {
    if (typeof peerId !== 'string' || !peerId) return false;
    return this.buckets.delete(peerId);
  }
  allow(peerId, cost = 1) {
    if (typeof peerId !== 'string' || !peerId || peerId.length > 256 || !Number.isFinite(cost) || cost <= 0 || cost > this.capacity) return false;
    const time = this.now();
    // A broken injected clock must fail closed without corrupting token state.
    if (!Number.isFinite(time)) return false;
    // Sweep a bounded rotating batch: an untrusted peer can grow this map up to
    // maxPeers, so a full scan on every frame is O(maxPeers) CPU under churn.
    // Rotate live buckets to the end so repeated calls eventually inspect all entries,
    // without relying on wall-clock timestamps being monotonic.
    const sweep = [];
    for (const entry of this.buckets) {
      sweep.push(entry);
      if (sweep.length >= 64) break;
    }
    for (const [id, bucket] of sweep) {
      if (time - bucket.lastSeen >= this.idleTtlMs) this.buckets.delete(id);
      else {
        this.buckets.delete(id);
        this.buckets.set(id, bucket);
      }
    }
    let old = this.buckets.get(peerId);
    if (!old) {
      if (this.buckets.size >= this.maxPeers) return false; // Fail closed instead of evicting active peers under attack.
      old = { tokens: this.capacity, at: time, lastSeen: time };
    } else if (time < old.at) {
      // A wall-clock rollback must not move the bucket's refill baseline backwards.
      // Otherwise, when time catches up, the same interval can refill tokens twice.
      // Reject without mutation; retryAfterMs() also fails closed until time catches up.
      return false;
    }
    const tokens = Math.min(this.capacity, old.tokens + (time - old.at) * this.refillPerMs);
    this.buckets.delete(peerId);
    this.buckets.set(peerId, { tokens: tokens >= cost ? tokens - cost : tokens, at: time, lastSeen: time });
    return tokens >= cost;
  }
}
