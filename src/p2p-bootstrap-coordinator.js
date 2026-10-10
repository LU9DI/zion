const MAX_BOOTSTRAP_PEERS = 32;
const PEER_ID_MAX = 256;
const MULTIADDR_MAX = 512;

function validatePeer(peer) {
  if (!peer || typeof peer !== 'object' || Array.isArray(peer) ||
      typeof peer.peerId !== 'string' || peer.peerId.length < 1 || peer.peerId.length > PEER_ID_MAX ||
      /[\r\n\0]/.test(peer.peerId) ||
      typeof peer.failureDomain !== 'string' || peer.failureDomain.trim().length < 1 || peer.failureDomain.length > 128 ||
      !Array.isArray(peer.multiaddrs) || peer.multiaddrs.length < 1 || peer.multiaddrs.length > 16 ||
      peer.multiaddrs.some(address => typeof address !== 'string' || address.length < 1 || address.length > MULTIADDR_MAX ||
        !address.startsWith('/') || /[\r\n\0\s]/.test(address))) {
    throw new TypeError('Invalid bootstrap peer configuration');
  }
  return Object.freeze({
    peerId: peer.peerId,
    failureDomain: peer.failureDomain.trim(),
    multiaddrs: Object.freeze([...new Set(peer.multiaddrs)]),
  });
}

/**
 * Coordinates diverse bootstrap connections. dialPeer must resolve only after
 * transport authentication and must return the actual remote peer ID; this class
 * cannot turn an unauthenticated socket into a trusted peer.
 */
export class P2PBootstrapCoordinator {
  constructor({
    bootstrapPeers, dialPeer, disconnectPeer = async () => {},
    minConnected = 2, maxConcurrent = 4, timeoutMs = 8_000,
  } = {}) {
    if (!Array.isArray(bootstrapPeers) || bootstrapPeers.length < 2 || bootstrapPeers.length > MAX_BOOTSTRAP_PEERS ||
        typeof dialPeer !== 'function' || typeof disconnectPeer !== 'function' ||
        !Number.isSafeInteger(minConnected) || minConnected < 2 || minConnected > bootstrapPeers.length ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new TypeError('Invalid P2P bootstrap coordinator configuration');
    }
    const peers = bootstrapPeers.map(validatePeer);
    if (new Set(peers.map(peer => peer.peerId)).size !== peers.length) throw new Error('Duplicate bootstrap peer ID');
    if (new Set(peers.map(peer => peer.failureDomain)).size < minConnected) {
      throw new Error('Bootstrap peers must span at least minConnected independent failure domains');
    }
    this.bootstrapPeers = Object.freeze(peers);
    this.dialPeer = dialPeer;
    this.disconnectPeer = disconnectPeer;
    this.minConnected = minConnected;
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this.state = 'stopped';
    this.connected = new Map();
    this.startController = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.lastFailures = Object.freeze([]);
  }

  getStatus() {
    return Object.freeze({
      state: this.state,
      connectedPeers: Object.freeze([...this.connected.values()].map(peer => Object.freeze({ ...peer }))),
      connectedCount: this.connected.size,
      failureDomains: Object.freeze([...new Set([...this.connected.values()].map(peer => peer.failureDomain))]),
      minimumConnected: this.minConnected,
      lastFailures: this.lastFailures,
    });
  }

  start({ signal } = {}) {
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    if (this.state !== 'stopped') return Promise.reject(new Error('Cannot start bootstrap coordinator from state ' + this.state));
    if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
      return Promise.reject(new TypeError('signal must be an AbortSignal'));
    }
    this.state = 'starting';
    const controller = new AbortController();
    this.startController = controller;
    const abortFromParent = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', abortFromParent, { once: true });

    const operation = this.#connectAll(controller.signal).then(result => {
      this.connected = new Map(result.map(peer => [peer.peerId, peer]));
      this.state = 'running';
      this.lastFailures = Object.freeze([]);
      return this.getStatus();
    }).catch(error => {
      this.state = 'stopped';
      this.lastFailures = Object.freeze([...(error.failures ?? []), { peerId: null, reason: String(error?.message ?? error).slice(0, 240) }]);
      throw error;
    }).finally(() => {
      signal?.removeEventListener('abort', abortFromParent);
      this.startController = null;
      this.startPromise = null;
    });
    this.startPromise = operation;
    return operation;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === 'starting') {
      this.startController?.abort(new Error('Bootstrap coordinator stopping'));
      await this.startPromise?.catch(() => {});
    }
    if (this.state === 'stopped') return this.getStatus();
    if (this.state !== 'running') throw new Error('Cannot stop bootstrap coordinator from state ' + this.state);
    this.state = 'stopping';
    const peers = [...this.connected.values()];
    const operation = (async () => {
      const outcomes = await Promise.allSettled(peers.map(peer => this.disconnectPeer(peer.peerId)));
      const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
        ? [{ peerId: peers[index].peerId, reason: String(outcome.reason?.message ?? outcome.reason).slice(0, 240) }]
        : []);
      if (failures.length) {
        this.lastFailures = Object.freeze(failures);
        this.state = 'failed';
        throw new AggregateError(failures.map(item => new Error(item.peerId + ': ' + item.reason)), 'Could not disconnect every bootstrap peer');
      }
      this.connected.clear();
      this.state = 'stopped';
      this.lastFailures = Object.freeze([]);
      return this.getStatus();
    })();
    this.stopPromise = operation.finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async #connectAll(signal) {
    const successes = [];
    const failures = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < this.bootstrapPeers.length && !signal.aborted) {
        const peer = this.bootstrapPeers[cursor++];
        try {
          const result = await this.#dialOne(peer, signal);
          if (result.peerId !== peer.peerId) throw new Error('Authenticated remote peer ID does not match bootstrap configuration');
          successes.push(Object.freeze({ peerId: peer.peerId, failureDomain: peer.failureDomain, multiaddrs: peer.multiaddrs }));
        } catch (error) {
          failures.push({ peerId: peer.peerId, reason: String(error?.message ?? error).slice(0, 240) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxConcurrent, this.bootstrapPeers.length) }, worker));
    this.lastFailures = Object.freeze(failures);
    const domains = new Set(successes.map(peer => peer.failureDomain));
    if (signal.aborted || successes.length < this.minConnected || domains.size < this.minConnected) {
      await Promise.allSettled(successes.map(peer => this.disconnectPeer(peer.peerId)));
      const error = new AggregateError(failures.map(item => new Error(item.peerId + ': ' + item.reason)),
        signal.aborted ? 'Bootstrap connection was cancelled' : 'Could not connect to enough independent bootstrap peers');
      error.failures = failures;
      throw error;
    }
    return successes;
  }

  async #dialOne(peer, parentSignal) {
    if (parentSignal.aborted) throw new Error('Bootstrap connection cancelled');
    const controller = new AbortController();
    const abort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('Bootstrap dial timed out'));
          reject(new Error('Bootstrap dial timed out'));
        }, this.timeoutMs);
      });
      const result = await Promise.race([
        Promise.resolve().then(() => this.dialPeer(peer, { signal: controller.signal })),
        timeout,
      ]);
      if (!result || result.authenticated !== true || typeof result.peerId !== 'string') {
        throw new Error('Bootstrap dial did not return an authenticated peer identity');
      }
      return result;
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abort);
    }
  }
}
