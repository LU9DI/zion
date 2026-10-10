import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { SocialMessageInbox } from './social-message-inbox.js';
import { verifySocialEnvelopeSignature, verifySocialMessageAcknowledgement } from './social-message-protocol.js';
import { SocialSessionAuthority } from './social-session-authority.js';

const MAX_BODY_BYTES = 128 * 1024;

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  res.end(bytes);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 }); }
}

/**
 * Minimal authenticated HTTP adapter around the durable inbox. Defaults to loopback.
 * The bearer secret is a deployment gate, not a replacement for per-peer authorization,
 * TLS, identity trust management, or a production P2P transport.
 */
export class SocialMessageNode {
  constructor({ inbox, filePath, bearerToken, host = '127.0.0.1', port = 0,
    authorizeSender = async () => false, authorizeRecipient = async () => false,
    verifyEnvelope = verifySocialEnvelopeSignature, verifyAcknowledgement, identityDirectory = null, authorizeInboxAccess = async () => false, sessionAuthority = null, maxRequestsPerMinute = 120 } = {}) {
    if (!inbox && !filePath) throw new TypeError('inbox or filePath is required');
    if (typeof bearerToken !== 'string' || Buffer.byteLength(bearerToken) < 32) throw new TypeError('bearerToken must contain at least 32 bytes');
    if (typeof authorizeSender !== 'function' || typeof authorizeRecipient !== 'function' || typeof verifyEnvelope !== 'function' || typeof authorizeInboxAccess !== 'function' || (verifyAcknowledgement !== undefined && typeof verifyAcknowledgement !== 'function')) throw new TypeError('authorization and verification callbacks are required');
    if (identityDirectory !== null && (typeof identityDirectory.getById !== 'function' || typeof identityDirectory.getByUsername !== 'function')) throw new TypeError('identityDirectory must expose getById and getByUsername');
    if (sessionAuthority !== null && (!(sessionAuthority instanceof SocialSessionAuthority) || !identityDirectory)) throw new TypeError('sessionAuthority requires a SocialSessionAuthority and identityDirectory');
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError('invalid port');
    if (!Number.isSafeInteger(maxRequestsPerMinute) || maxRequestsPerMinute < 1) throw new RangeError('invalid rate limit');
    this.inbox = inbox ?? new SocialMessageInbox({ filePath });
    this.bearerToken = bearerToken;
    this.host = host;
    this.port = port;
    this.authorizeSender = authorizeSender;
    this.authorizeRecipient = authorizeRecipient;
    this.verifyEnvelope = verifyEnvelope;
    this.identityDirectory = identityDirectory;
    this.sessionAuthority = sessionAuthority;
    this.authorizeInboxAccess = authorizeInboxAccess;
    this.verifyAcknowledgement = verifyAcknowledgement ?? (identityDirectory
      ? async ack => {
          const profile = await identityDirectory.getById(ack?.recipientId);
          return Boolean(profile && verifySocialMessageAcknowledgement(ack, { trustedRecipientSigningPublicKeyPem: profile.signingPublicKeyPem }));
        }
      : async () => false);
    this.maxRequestsPerMinute = maxRequestsPerMinute;
    this.requests = new Map();
    this.server = createServer((req, res) => { void this.#handle(req, res); });
  }

  async listen() {
    await this.inbox.init();
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
      if (req.method === 'GET' && req.url === '/api/v1/health') return send(res, 200, { ok: true, service: 'zion-social-messages', protocol: 1 });
      if (req.method === 'GET' && this.identityDirectory) {
        const profileUrl = new URL(req.url, 'http://zion.local');
        if (profileUrl.pathname === '/api/v1/profiles') {
          const username = profileUrl.searchParams.get('username');
          if (username) {
            const profile = await this.identityDirectory.getByUsername(username);
            return profile ? send(res, 200, { profile }) : send(res, 404, { error: 'profile_not_found' });
          }
          const limit = Number(profileUrl.searchParams.get('limit') ?? 50);
          const after = profileUrl.searchParams.get('after') ?? '';
          return send(res, 200, { profiles: await this.identityDirectory.list({ limit, after }) });
        }
        const profileMatch = profileUrl.pathname.match(/^\/api\/v1\/profiles\/(zion:[a-f0-9]{64})$/);
        if (profileMatch) {
          const profile = await this.identityDirectory.getById(profileMatch[1]);
          return profile ? send(res, 200, { profile }) : send(res, 404, { error: 'profile_not_found' });
        }
      }
      const url = new URL(req.url, 'http://zion.local');
      const isAuthRoute = req.method === 'POST' && (url.pathname === '/api/v1/auth/challenge' || url.pathname === '/api/v1/auth/session');
      if (this.sessionAuthority && isAuthRoute) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const recent = (this.requests.get(ip) ?? []).filter(t => now - t < 60_000);
        if (recent.length >= this.maxRequestsPerMinute) return send(res, 429, { error: 'rate_limit_exceeded' });
        recent.push(now); this.requests.set(ip, recent);
        if (this.requests.size > 2048) this.requests.delete(this.requests.keys().next().value);
      }
      if (this.sessionAuthority && req.method === 'POST' && url.pathname === '/api/v1/auth/challenge') {
        const body = await readJson(req);
        try { return send(res, 200, { challenge: await this.sessionAuthority.issueChallenge(body?.identityId) }); }
        catch (error) {
          if (error.code === 'IDENTITY_NOT_FOUND') return send(res, 404, { error: 'identity_not_found' });
          if (error.code === 'CAPACITY') return send(res, 429, { error: 'authentication_capacity_reached' });
          throw error;
        }
      }
      if (this.sessionAuthority && req.method === 'POST' && url.pathname === '/api/v1/auth/session') {
        const body = await readJson(req);
        try { return send(res, 200, await this.sessionAuthority.createSession(body)); }
        catch (error) {
          if (error.code === 'INVALID_PROOF') return send(res, 401, { error: 'invalid_or_expired_challenge' });
          if (error.code === 'CAPACITY') return send(res, 429, { error: 'authentication_capacity_reached' });
          throw error;
        }
      }
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const session = this.sessionAuthority ? this.sessionAuthority.authenticateToken(token) : null;
      if (this.sessionAuthority ? !session : !sameSecret(token, this.bearerToken)) return send(res, 401, { error: 'unauthorized' });
      const ip = req.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      const recent = (this.requests.get(ip) ?? []).filter(t => now - t < 60_000);
      if (recent.length >= this.maxRequestsPerMinute) return send(res, 429, { error: 'rate_limit_exceeded' });
      recent.push(now); this.requests.set(ip, recent);
      if (this.requests.size > 2048) this.requests.delete(this.requests.keys().next().value);

      if (req.method === 'POST' && url.pathname === '/api/v1/messages') {
        const envelope = await readJson(req);
        const senderProfile = this.identityDirectory ? await this.identityDirectory.getById(envelope?.senderId) : null;
        const senderAllowed = this.sessionAuthority
          ? Boolean(session.identityId === envelope?.senderId && senderProfile && senderProfile.signingPublicKeyPem === envelope?.senderSigningPublicKeyPem)
          : this.identityDirectory
            ? Boolean(senderProfile && senderProfile.signingPublicKeyPem === envelope?.senderSigningPublicKeyPem)
            : await this.authorizeSender({ senderId: envelope?.senderId, token, envelope });
        if (!senderAllowed) return send(res, 403, { error: 'sender_forbidden' });
        const recipientAllowed = this.identityDirectory
          ? Boolean(await this.identityDirectory.getById(envelope?.recipientId))
          : await this.authorizeRecipient({ recipientId: envelope?.recipientId, token, envelope });
        if (!recipientAllowed) return send(res, 403, { error: 'recipient_forbidden' });
        if (!this.verifyEnvelope(envelope)) return send(res, 400, { error: 'invalid_signature' });
        const result = await this.inbox.enqueue(envelope);
        return send(res, result.duplicate ? 200 : 202, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/inbox') {
        const recipientId = url.searchParams.get('recipient');
        const recipientAllowed = recipientId && (this.sessionAuthority
          ? session.identityId === recipientId
          : this.identityDirectory
            ? Boolean(await this.identityDirectory.getById(recipientId)) && await this.authorizeInboxAccess({ recipientId, token, request: req })
            : await this.authorizeRecipient({ recipientId, token }));
        if (!recipientAllowed) return send(res, 403, { error: 'recipient_forbidden' });
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const after = Number(url.searchParams.get('after') ?? 0);
        return send(res, 200, { messages: await this.inbox.list(recipientId, { limit, after }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/inbox/ack') {
        const body = await readJson(req);
        const recipientAllowed = body?.recipientId && (this.sessionAuthority
          ? session.identityId === body.recipientId && Boolean(await this.identityDirectory.getById(body.recipientId))
          : this.identityDirectory
            ? Boolean(await this.identityDirectory.getById(body.recipientId))
            : await this.authorizeRecipient({ recipientId: body.recipientId, token }));
        if (!recipientAllowed) return send(res, 403, { error: 'recipient_forbidden' });
        if (!await this.verifyAcknowledgement(body)) return send(res, 400, { error: 'invalid_recipient_acknowledgement' });
        return send(res, 200, await this.inbox.acknowledge(body.recipientId, body.queueIds));
      }
      if (!['GET', 'POST', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'method_not_allowed' });
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.statusCode ?? (error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 500);
      send(res, status, { error: status === 500 ? 'internal_error' : error.message });
    }
  }
}
