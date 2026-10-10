/**
 * Owns the logical lifecycle of a storage adapter used by an official node.
 * RustStorageAdapter is a one-shot sidecar client, so "running" here means the
 * backend has initialized and the node lifecycle currently permits storage calls.
 */
export class RustStorageLifecycle {
  constructor(adapter) {
    if (!adapter || typeof adapter.init !== 'function' || typeof adapter.put !== 'function' ||
        typeof adapter.get !== 'function' || typeof adapter.usage !== 'function') {
      throw new TypeError('Storage adapter must implement init(), put(), get(), and usage()');
    }
    this.adapter = adapter;
    this.state = 'stopped';
    this.activeOperations = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.drainWaiters = [];
    this.lastError = null;
  }

  start() {
    if (this.state === 'running') return Promise.reject(new Error('Storage lifecycle already running'));
    if (this.state === 'starting' && this.startPromise) return this.startPromise;
    if (this.state !== 'stopped') return Promise.reject(new Error(`Cannot start storage lifecycle from state ${this.state}`));
    this.state = 'starting';
    const operation = (async () => {
      try {
        await this.adapter.init();
        this.state = 'running';
        this.lastError = null;
        return this.getStatus();
      } catch (error) {
        this.state = 'stopped';
        this.lastError = String(error?.message ?? error).slice(0, 240);
        throw error;
      }
    })();
    this.startPromise = operation.finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (this.state === 'stopped') return this.getStatus();
    if (!['running', 'failed'].includes(this.state)) throw new Error(`Cannot stop storage lifecycle from state ${this.state}`);
    this.state = 'stopping';
    const operation = (async () => {
      try {
        if (this.activeOperations > 0) await new Promise(resolve => this.drainWaiters.push(resolve));
        if (typeof this.adapter.close === 'function') await this.adapter.close();
        this.state = 'stopped';
        this.lastError = null;
        return this.getStatus();
      } catch (error) {
        this.state = 'failed';
        this.lastError = String(error?.message ?? error).slice(0, 240);
        throw error;
      }
    })();
    this.stopPromise = operation.finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  getStatus() {
    return Object.freeze({
      running: this.state === 'running',
      state: this.state,
      activeOperations: this.activeOperations,
      backend: 'rust-storage-adapter',
      lastError: this.lastError,
    });
  }

  put(chunkId, envelope) { return this.#run('put', [chunkId, envelope]); }
  get(chunkId) { return this.#run('get', [chunkId]); }
  usage() { return this.#run('usage', []); }

  async #run(method, args) {
    if (this.state !== 'running') {
      const error = new Error(`Storage backend is not accepting operations (state: ${this.state})`);
      error.code = 'ZION_STORAGE_NOT_RUNNING';
      throw error;
    }
    this.activeOperations += 1;
    try {
      return await this.adapter[method](...args);
    } catch (error) {
      this.lastError = String(error?.message ?? error).slice(0, 240);
      throw error;
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.drainWaiters.splice(0)) resolve();
      }
    }
  }
}

/**
 * Callback bundle for OfficialNodeBootstrap. Pass lifecycle itself as the store
 * to PeerStorageService so shutdown gates both the node and storage requests.
 */
export function rustStorageBootstrapHooks(lifecycle) {
  if (!lifecycle || typeof lifecycle.start !== 'function' || typeof lifecycle.stop !== 'function' ||
      typeof lifecycle.getStatus !== 'function') throw new TypeError('A RustStorageLifecycle instance is required');
  return Object.freeze({
    startStorage: () => lifecycle.start(),
    stopStorage: () => lifecycle.stop(),
    getStorageStatus: () => lifecycle.getStatus(),
  });
}
