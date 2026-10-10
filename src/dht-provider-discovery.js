const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_PROVIDERS = 32;
const DEFAULT_TIMEOUT_MS = 8_000;

async function runWithTimeout(operation, timeoutMs, message, onTimeout = () => {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try { onTimeout(); } catch { /* cancellation is best-effort */ }
      reject(new Error(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thin adapter over libp2p's ContentRouting API. Pass node.contentRouting and
 * a CID factory from the application's chosen multiformats setup. Keeping CID
 * construction injected avoids silently inventing a CID codec for chunk IDs.
 */
export class Libp2pContentRoutingAdapter {
  constructor({ contentRouting, cidForChunk } = {}) {
    if (!contentRouting || typeof contentRouting.provide !== 'function' || typeof contentRouting.findProviders !== 'function') {
      throw new TypeError('contentRouting must implement provide() and findProviders()');
    }
    if (typeof cidForChunk !== 'function') throw new TypeError('cidForChunk must be a function');
    this.contentRouting = contentRouting;
    this.cidForChunk = cidForChunk;
  }

  async provideChunk(chunkId, options = {}) {
    this.#assertChunkId(chunkId);
    const cid = await this.cidForChunk(chunkId);
    if (!cid) throw new TypeError('cidForChunk returned no CID');
    return this.contentRouting.provide(cid, options);
  }

  findChunkProviders(chunkId, options = {}) {
    this.#assertChunkId(chunkId);
    // Resolve the CID before returning the async iterator, so errors are
    // surfaced to the caller and are not hidden in an iterator implementation.
    const self = this;
    return (async function* () {
      const cid = await self.cidForChunk(chunkId);
      if (!cid) throw new TypeError('cidForChunk returned no CID');
      yield* self.contentRouting.findProviders(cid, options);
    })();
  }

  #assertChunkId(chunkId) {
    if (typeof chunkId !== 'string' || !HASH.test(chunkId)) throw new TypeError('Invalid chunk ID');
  }
}

/**
 * Bounded provider discovery policy. DHT answers are untrusted hints: callers
 * must authenticate peers and verify downloaded ciphertext against chunkId.
 */
export class DhtProviderDiscovery {
  constructor({ routing, hasChunk, maxProviders = DEFAULT_MAX_PROVIDERS, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!routing || typeof routing.provideChunk !== 'function' || typeof routing.findChunkProviders !== 'function') {
      throw new TypeError('routing must implement provideChunk() and findChunkProviders()');
    }
    if (typeof hasChunk !== 'function') throw new TypeError('hasChunk must be a function');
    if (!Number.isSafeInteger(maxProviders) || maxProviders < 1 || maxProviders > 256 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new RangeError('Invalid DHT discovery limits');
    this.routing = routing;
    this.hasChunk = hasChunk;
    this.maxProviders = maxProviders;
    this.timeoutMs = timeoutMs;
  }

  async announce(chunkId) {
    this.#assertChunkId(chunkId);
    return runWithTimeout(async signal => {
      if (!(await this.hasChunk(chunkId, { signal }))) throw new Error('Cannot announce a chunk that is not locally available');
      await this.routing.provideChunk(chunkId, { signal });
      return Object.freeze({ chunkId, announced: true });
    }, this.timeoutMs, 'DHT chunk announcement timed out');
  }

  async findProviders(chunkId) {
    this.#assertChunkId(chunkId);
    const found = new Map();
    let iterator;
    return runWithTimeout(async signal => {
      iterator = this.routing.findChunkProviders(chunkId, { signal })[Symbol.asyncIterator]();
      while (found.size < this.maxProviders) {
        const result = await iterator.next();
        if (result.done) break;
        const provider = result.value;
        const peerId = provider?.id?.toString?.() ?? provider?.peerId;
        if (typeof peerId !== 'string' || peerId.length < 1 || peerId.length > 256 || /[\r\n\0]/.test(peerId)) continue;
        if (!found.has(peerId)) {
          const multiaddrs = Array.isArray(provider.multiaddrs)
            ? [...new Set(provider.multiaddrs.map(addr => typeof addr?.toString === 'function' ? addr.toString() : '').filter(addr => addr.length > 0 && addr.length <= 512 && !/[\r\n\0]/.test(addr)))].slice(0, 16)
            : [];
          found.set(peerId, Object.freeze({ peerId, multiaddrs: Object.freeze(multiaddrs) }));
        }
      }
      return Object.freeze([...found.values()]);
    }, this.timeoutMs, 'DHT provider discovery timed out', () => { Promise.resolve(iterator?.return?.()).catch(() => {}); });
  }

  #assertChunkId(chunkId) {
    if (typeof chunkId !== 'string' || !HASH.test(chunkId)) throw new TypeError('Invalid chunk ID');
  }
}
