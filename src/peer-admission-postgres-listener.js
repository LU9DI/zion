const NODE_ID = /^[a-f0-9]{64}$/;
const CHANNEL = 'zion_peer_revocations';

/**
 * Dedicated-session PostgreSQL LISTEN consumer for peer revocations.
 * Notifications are an acceleration path only: callers must retain authoritative
 * per-frame admission checks because LISTEN gaps can occur during reconnects.
 */
export class PostgresPeerRevocationListener {
  constructor({ pool, onRevocation = null, minReconnectMs = 250, maxReconnectMs = 30_000 } = {}) {
    if (!pool || typeof pool.connect !== 'function' || (onRevocation !== null && typeof onRevocation !== 'function') ||
      !Number.isSafeInteger(minReconnectMs) || minReconnectMs < 10 ||
      !Number.isSafeInteger(maxReconnectMs) || maxReconnectMs < minReconnectMs) {
      throw new TypeError('Invalid PostgreSQL peer-revocation listener configuration');
    }
    this.pool = pool;
    this.onRevocation = onRevocation;
    this.minReconnectMs = minReconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.client = null;
    this.clientHandlers = null;
    this.running = false;
    this.connecting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.generation = 0;
  }

  async start(onRevocation = this.onRevocation) {
    if (typeof onRevocation !== 'function') throw new TypeError('A revocation callback is required');
    this.onRevocation = onRevocation;
    if (this.running) return;
    this.running = true;
    this.generation++;
    try {
      await this.#connect(this.generation);
    } catch (error) {
      this.running = false;
      this.generation++;
      await this.#releaseClient();
      throw error;
    }
  }

  async #connect(generation) {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = await this.pool.connect();
      if (!this.running || generation !== this.generation) {
        client.release();
        return;
      }
      this.client = client;
      const onNotification = message => {
        if (message?.channel !== CHANNEL || !NODE_ID.test(message.payload ?? '')) return;
        try { Promise.resolve(this.onRevocation(message.payload)).catch(() => {}); }
        catch { /* a notification callback must not crash the pg event loop */ }
      };
      const onFailure = error => {
        if (this.client !== client) return;
        this.client = null;
        this.clientHandlers = null;
        client.off('notification', onNotification);
        client.off('error', onFailure);
        client.off('end', onFailure);
        try { client.release(error); } catch { /* broken client is already unusable */ }
        this.#scheduleReconnect(generation);
      };
      this.clientHandlers = { client, onNotification, onFailure };
      client.on('notification', onNotification);
      client.on('error', onFailure);
      client.on('end', onFailure);
      try {
        await client.query(`LISTEN ${CHANNEL}`);
      } catch (error) {
        client.off('notification', onNotification);
        client.off('error', onFailure);
        client.off('end', onFailure);
        const stillOwned = this.client === client;
        if (stillOwned) this.client = null;
        if (this.clientHandlers?.client === client) this.clientHandlers = null;
        // onFailure may already have released this client while LISTEN was pending.
        if (stillOwned) {
          try { client.release(error); } catch {}
        }
        throw error;
      }
      // A socket error/end can arrive while the LISTEN query is still settling.
      // onFailure owns release and reconnect in that case; do not report a dead
      // session as connected or release it a second time.
      if (this.client !== client) return;
      if (!this.running || generation !== this.generation) {
        client.off('notification', onNotification);
        client.off('error', onFailure);
        client.off('end', onFailure);
        if (this.client === client) this.client = null;
        if (this.clientHandlers?.client === client) this.clientHandlers = null;
        // stop() can race with LISTEN. Clear the session subscription before
        // returning the connection to the pool, otherwise the next borrower
        // inherits a live LISTEN registration.
        try { await client.query(`UNLISTEN ${CHANNEL}`); } catch {}
        try { client.release(); } catch {}
        return;
      }
      this.reconnectAttempt = 0;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  #scheduleReconnect(generation) {
    if (!this.running || generation !== this.generation || this.reconnectTimer) return;
    const delay = Math.min(this.maxReconnectMs,
      this.minReconnectMs * (2 ** Math.min(this.reconnectAttempt++, 16)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect(generation).catch(() => this.#scheduleReconnect(generation));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async #releaseClient() {
    const client = this.client;
    const handlers = this.clientHandlers;
    this.client = null;
    this.clientHandlers = null;
    if (!client) return;
    if (handlers?.client === client) {
      client.off('notification', handlers.onNotification);
      client.off('error', handlers.onFailure);
      client.off('end', handlers.onFailure);
    }
    try { await client.query(`UNLISTEN ${CHANNEL}`); } catch {}
    try { client.release(); } catch {}
  }

  async stop() {
    this.running = false;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connecting) await this.connecting.catch(() => {});
    await this.#releaseClient();
    this.reconnectAttempt = 0;
  }
}
