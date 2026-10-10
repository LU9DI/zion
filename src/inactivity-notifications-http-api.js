import { createServer } from 'node:http';

const ROUTE = '/api/v1/notifications/inactivity';
const SAFE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

function send(res, status, body, extraHeaders = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...SAFE_HEADERS, 'content-length': bytes.length, ...extraHeaders });
  res.end(bytes);
}

function safeIdentityId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function publicRecord(record) {
  // Never expose owner identifiers, internal deduplication keys, or provider receipts.
  const { ownerIdentityId, eventKey, deliveryReceipt, ...safe } = record;
  return safe;
}

/** Authenticated, owner-scoped read/view API for inactivity notifications. */
export class InactivityNotificationsHttpApi {
  constructor({ store, sessionAuthority, host = '127.0.0.1', port = 0, allowRemoteBinding = false,
    maxRequestsPerMinute = 120, now = () => Date.now() } = {}) {
    if (!store || typeof store.list !== 'function' || typeof store.markViewed !== 'function' ||
        !sessionAuthority || typeof sessionAuthority.authenticateToken !== 'function') {
      throw new TypeError('store and sessionAuthority with authenticateToken are required');
    }
    if (typeof host !== 'string' || !host.trim() || (!allowRemoteBinding && !['127.0.0.1', '::1', 'localhost'].includes(host))) {
      throw new TypeError('Remote binding requires allowRemoteBinding=true and a trusted TLS ingress');
    }
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxRequestsPerMinute) ||
        maxRequestsPerMinute < 1 || maxRequestsPerMinute > 10000 || typeof now !== 'function') throw new RangeError('Invalid API limits');
    this.store = store;
    this.sessionAuthority = sessionAuthority;
    this.host = host;
    this.port = port;
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.now = now;
    this.requests = new Map();
    this.server = createServer((req, res) => { void this.#handle(req, res); });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.maxHeadersCount = 50;
  }

  async listen() {
    await new Promise((resolve, reject) => {
      const onError = error => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    return Object.freeze({ host: this.host, port: address.port });
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }

  async #handle(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://zion.local');
      const viewedMatch = url.pathname.match(/^\/api\/v1\/notifications\/inactivity\/([0-9a-f-]{36})\/viewed$/iu);
      if (url.pathname !== ROUTE && !viewedMatch) return send(res, 404, { error: 'not_found' });
      const methodAllowed = url.pathname === ROUTE ? req.method === 'GET' : req.method === 'POST';
      if (!methodAllowed) {
        const allow = url.pathname === ROUTE ? 'GET' : 'POST';
        return send(res, 405, { error: 'method_not_allowed' }, { allow });
      }
      const ip = req.socket.remoteAddress ?? 'unknown';
      const current = this.now();
      const recent = (this.requests.get(ip) ?? []).filter(timestamp => current - timestamp >= 0 && current - timestamp < 60_000);
      if (recent.length >= this.maxRequestsPerMinute) return send(res, 429, { error: 'rate_limit_exceeded' });
      recent.push(current);
      this.requests.set(ip, recent);
      if (this.requests.size > 2048) this.requests.delete(this.requests.keys().next().value);

      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !authorization.slice(7).trim()) {
        return send(res, 401, { error: 'unauthorized' });
      }
      let session;
      try { session = this.sessionAuthority.authenticateToken(authorization.slice(7).trim()); }
      catch { return send(res, 401, { error: 'unauthorized' }); }
      if (!session || !safeIdentityId(session.identityId)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET') {
        const status = url.searchParams.get('status') ?? 'all';
        const rawLimit = url.searchParams.get('limit') ?? '100';
        if (!['all', 'pending', 'delivered', 'ambiguous'].includes(status) || !/^[1-9]\d{0,2}$/u.test(rawLimit) || Number(rawLimit) > 500 ||
            [...url.searchParams.keys()].some(key => !['status', 'limit'].includes(key))) {
          return send(res, 400, { error: 'invalid_query' });
        }
        const notifications = await this.store.list(session.identityId, { status, limit: Number(rawLimit) });
        return send(res, 200, { ok: true, notifications: notifications.map(publicRecord) });
      }

      if (req.headers['content-length'] && Number(req.headers['content-length']) > 0) return send(res, 400, { error: 'request_body_not_allowed' });
      const notification = await this.store.markViewed(session.identityId, viewedMatch[1]);
      return send(res, 200, { ok: true, notification: publicRecord(notification) });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const code = error?.code === 'NOTIFICATION_NOT_FOUND' ? 404 : error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      return send(res, code, { error: code === 404 ? 'not_found' : code >= 500 ? 'internal_error' : 'request_failed' });
    }
  }
}
