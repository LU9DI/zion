import { createServer } from 'node:http';

const MAX_BODY_BYTES = 8 * 1024;
const ROUTE = '/api/v1/settings/inactivity';

function send(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'pragma': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  });
  res.end(bytes);
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('content_type_must_be_application_json'), { statusCode: 415 });
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw Object.assign(new Error('request_body_too_large'), { statusCode: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request_body_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
    return body;
  } catch {
    throw Object.assign(new Error('invalid_json_body'), { statusCode: 400 });
  }
}

/**
 * HTTP transport for InactivitySettingsService. It binds to loopback by default.
 * Remote binding must only be enabled behind a TLS-terminating, trusted ingress.
 * Session tokens are accepted only through Authorization: Bearer; identity IDs in
 * request bodies are never used to select the settings owner.
 */
export class InactivitySettingsHttpApi {
  constructor({ service, host = '127.0.0.1', port = 0, allowRemoteBinding = false,
    maxRequestsPerMinute = 60, now = () => Date.now() } = {}) {
    if (!service || typeof service.getSettings !== 'function' || typeof service.updateSettings !== 'function' || typeof service.resetSettings !== 'function') {
      throw new TypeError('service must implement getSettings, updateSettings, and resetSettings');
    }
    if (typeof host !== 'string' || !host.trim() || (!allowRemoteBinding && !['127.0.0.1', '::1', 'localhost'].includes(host))) {
      throw new TypeError('Remote binding requires allowRemoteBinding=true and a trusted TLS ingress');
    }
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError('invalid port');
    if (!Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1 || maxRequestsPerMinute > 10000 || typeof now !== 'function') throw new RangeError('invalid API limits');
    this.service = service;
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
      if (url.pathname !== ROUTE) return send(res, 404, { error: 'not_found' });
      if (!['GET', 'PUT', 'DELETE'].includes(req.method)) {
        res.setHeader('allow', 'GET, PUT, DELETE');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const ip = req.socket.remoteAddress ?? 'unknown';
      const now = this.now();
      const recent = (this.requests.get(ip) ?? []).filter(timestamp => now - timestamp >= 0 && now - timestamp < 60_000);
      if (recent.length >= this.maxRequestsPerMinute) return send(res, 429, { error: 'rate_limit_exceeded' });
      recent.push(now);
      this.requests.set(ip, recent);
      if (this.requests.size > 2048) this.requests.delete(this.requests.keys().next().value);

      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !authorization.slice(7).trim()) {
        return send(res, 401, { error: 'unauthorized' });
      }
      const token = authorization.slice(7).trim();
      if (req.method === 'GET') return send(res, 200, await this.service.getSettings(token));
      if (req.method === 'PUT') {
        const body = await readJson(req);
        // The service performs strict schema validation and binds to the token identity.
        return send(res, 200, await this.service.updateSettings(token, body));
      }
      if (req.method === 'DELETE') {
        // DELETE does not accept a body: avoids ambiguous reset semantics.
        if (req.headers['content-length'] && Number(req.headers['content-length']) > 0) return send(res, 400, { error: 'delete_body_not_allowed' });
        return send(res, 200, await this.service.resetSettings(token));
      }
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error?.status ?? error?.statusCode ?? (error instanceof TypeError ? 400 : error instanceof RangeError ? 400 : 500);
      const safeCode = status >= 500 ? 'internal_error' : String(error?.message ?? 'request_failed').slice(0, 100);
      return send(res, status, { error: safeCode });
    }
  }
}
