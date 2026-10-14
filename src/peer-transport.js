import { createServer as createTcpServer, createConnection } from 'node:net';
import { createServer as createTlsServer, connect as createTlsConnection } from 'node:tls';
import { isIP as netIsIpAddress } from 'node:net';
import { randomBytes } from 'node:crypto';
import { signPeerMessage, verifyPeerMessage, ReplayGuard, PeerRateLimiter } from './peer-security.js';
import { calculateNetworkId, validateGenesisDocument } from './protocol-genesis.js';
import { validateProtocolOperation } from './protocol-operation-validator.js';

const MAX_FRAME_BYTES = 256 * 1024;
const isLoopbackAddress = host => {
  if (typeof host !== 'string') return false;
  const normalized = host.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice('::ffff:'.length));
  // Do not trust a loose regex: values such as 127.999.1.1 are not IP literals.
  return netIsIpAddress(normalized) === 4 && normalized.split('.')[0] === '127';
};
// Treat only validated IP literals as loopback. Hostnames can be redirected by local resolver configuration.
const isLoopbackHost = host => isLoopbackAddress(host);
const MAX_QUEUED_FRAMES_PER_SOCKET = 64;
const MAX_QUEUED_FRAME_BYTES_PER_SOCKET = 4; // multiplier of the configured maximum frame size
const MAX_THROTTLE_MS = 5_000;
const MAX_THROTTLE_WAITS = 8;
const DEFAULT_TYPES = new Set(['PING', 'PONG', 'STORE_CHUNK', 'GET_CHUNK', 'CHUNK_DATA', 'MANIFEST', 'STORE_REQUEST', 'STORE_RECEIPT', 'STORE_REJECTED']);

/**
 * Minimal authenticated newline-framed TCP transport.
 * Defaults to loopback; remote binding must be an explicit operator decision.
 * Payload handlers must validate every operation and enforce local storage/resource policy.
 */
export class PeerTransport {
  constructor({ identity, host = '127.0.0.1', port = 0, maxConnections = 64,
    maxFrameBytes = MAX_FRAME_BYTES, allowedTypes = DEFAULT_TYPES, trustedPeerIds = null,
    onMessage = async () => {}, replayGuard = new ReplayGuard(),
    rateLimiter = new PeerRateLimiter({ capacity: 128, refillPerSecond: 100 }),
    // Tier 1: strict budget for peers that have not completed the handshake (keyed by nodeId).
    unauthenticatedRateLimiter = new PeerRateLimiter({ capacity: 16, refillPerSecond: 5 }),
    // Tier 0: cheap per-socket budget checked BEFORE signature verification, so unsigned/forged floods cannot burn CPU.
    socketRateLimiter = new PeerRateLimiter({ capacity: 256, refillPerSecond: 200 }), transferScheduler = null,
    protocolGenesis = null, networkMode = 'legacy', integrityGuard = null, admissionController = null, admissionVouchers = [], tlsOptions = null, tlsHandshakeTimeoutMs = 10_000, now = () => Date.now() } = {}) {
    if (!identity?.privateKey || typeof identity.nodeId !== 'string') throw new TypeError('A node identity is required');
    if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('Invalid bind address');
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 256) throw new RangeError('Invalid transport limits');
    if (!Number.isSafeInteger(tlsHandshakeTimeoutMs) || tlsHandshakeTimeoutMs < 100 || tlsHandshakeTimeoutMs > 60_000) throw new RangeError('Invalid TLS handshake timeout');
    if (typeof onMessage !== 'function') throw new TypeError('onMessage must be a function');
    if (!['legacy', 'official'].includes(networkMode)) throw new TypeError('networkMode must be legacy or official');
    if (networkMode === 'official' && protocolGenesis === null) throw new Error('Official Zion network mode requires a reviewed protocol genesis');
    if (trustedPeerIds !== null && (!Array.isArray(trustedPeerIds) || trustedPeerIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)))) throw new TypeError('trustedPeerIds must be null or an array of SHA-256 node IDs');
    if (!isLoopbackHost(host) && (!trustedPeerIds || trustedPeerIds.length === 0)) throw new Error('Non-loopback binding requires an explicit trustedPeerIds allowlist');
    const hasMaterial = value => Buffer.isBuffer(value) ? value.length > 0
      : typeof value === 'string' ? value.trim().length > 0
        : Array.isArray(value) ? value.length > 0 && value.every(item => hasMaterial(item)) : false;
    const tlsReady = Boolean(tlsOptions && hasMaterial(tlsOptions.key) &&
      hasMaterial(tlsOptions.cert) && hasMaterial(tlsOptions.ca));
    if (!isLoopbackHost(host) && !tlsReady) throw new Error('Non-loopback binding requires mutual TLS options (key, cert, ca); signed messages alone do not encrypt transport');
    if (tlsOptions !== null && !tlsReady) throw new TypeError('tlsOptions must provide key, cert, and CA material for mutual TLS');
    this.tlsOptions = tlsReady ? tlsOptions : null;
    this.tlsHandshakeTimeoutMs = tlsHandshakeTimeoutMs;
    this.identity = identity; this.host = host; this.port = port; this.maxConnections = maxConnections;
    this.networkMode = networkMode;
    this.genesis = protocolGenesis === null ? null : validateGenesisDocument(protocolGenesis);
    if (this.genesis && maxFrameBytes > this.genesis.limits.maxFrameBytes) throw new RangeError('Transport frame limit exceeds protocol genesis');
    if (networkMode === 'official' && (!integrityGuard || typeof integrityGuard.checkHealthy !== 'function' || typeof integrityGuard.assertHealthy !== 'function')) throw new Error('Official Zion mode requires a verified IntegrityGuard');
    if (admissionController !== null && (networkMode !== 'official' || !protocolGenesis || !trustedPeerIds || trustedPeerIds.length === 0 || typeof admissionController.admit !== 'function' || typeof admissionController.isAdmitted !== 'function')) throw new Error('Invite admission requires an official network, genesis, bootstrap allowlist, and compatible admission controller');
    if (!Array.isArray(admissionVouchers) || admissionVouchers.length > 16) throw new TypeError('admissionVouchers must be an array of at most 16 vouchers');
    if (admissionVouchers.length && (networkMode !== 'official' || !protocolGenesis)) throw new Error('Admission vouchers require an official network with a protocol genesis');
    this.integrityGuard = integrityGuard;
    this.admissionController = admissionController;
    this.admissionVouchers = Object.freeze([...admissionVouchers]);
    this.admittedPeerIds = new Set();
    this.maxFrameBytes = maxFrameBytes; this.maxMessageBytes = this.genesis?.limits.maxMessageBytes ?? maxFrameBytes; this.allowedTypes = new Set(allowedTypes); this.trustedPeerIds = trustedPeerIds === null ? null : new Set(trustedPeerIds); this.onMessage = onMessage;
    this.replayGuard = replayGuard; this.rateLimiter = rateLimiter; this.unauthenticatedRateLimiter = unauthenticatedRateLimiter; this.socketRateLimiter = socketRateLimiter; this.transferScheduler = transferScheduler; this.now = now;
    this.networkId = this.genesis ? calculateNetworkId(this.genesis) : null;
    this.connections = new Set(); this.server = null; this.started = false;
    this.removeQuarantineListener = this.networkMode === 'official' && typeof integrityGuard.addQuarantineListener === 'function'
      ? integrityGuard.addQuarantineListener(report => this.#isolateForIntegrityFailure(report?.reason ?? 'integrity-quarantine'))
      : null;
    if (this.networkMode === 'official' && integrityGuard.status?.quarantined) {
      this.#isolateForIntegrityFailure(integrityGuard.status.reason ?? 'integrity-quarantine');
    }
  }

  async listen() {
    if (this.started) throw new Error('Transport already started');
    if (this.networkMode === 'official') await this.integrityGuard.checkHealthy();
    this.server = this.tlsOptions
      ? createTlsServer({ ...this.tlsOptions, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: this.tlsHandshakeTimeoutMs }, socket => this.#accept(socket))
      : createTcpServer(socket => this.#accept(socket));
    this.server.maxConnections = this.maxConnections;
    await new Promise((resolve, reject) => {
      const onError = error => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError); this.server.once('listening', onListening);
      this.server.listen({ host: this.host, port: this.port, backlog: this.maxConnections });
    });
    this.started = true;
    const address = this.server.address();
    return Object.freeze({ host: address.address, port: address.port });
  }

  #accept(socket) {
    if (this.connections.size >= this.maxConnections) { socket.destroy(); return; }
    this.#attach(socket);
  }

  #attach(socket) {
    this.connections.add(socket);
    const session = { id: randomBytes(16).toString('hex'), localNonce: randomBytes(32).toString('hex'), remoteNonce: null, authenticated: !this.genesis };
    socket.__zionSession = session;
    socket.setTimeout(15_000, () => socket.destroy());
    socket.setNoDelay(true);
    let pending = Buffer.alloc(0);
    let queuedFrames = 0;
    let queuedFrameBytes = 0;
    let processing = Promise.resolve();
    socket.on('data', chunk => {
      if (socket.destroyed) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > this.maxFrameBytes && !pending.includes(0x0a)) { socket.destroy(); return; }
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const frame = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (!frame.length || frame.length > this.maxFrameBytes) { socket.destroy(); return; }
        // Bound both queued frame count and queued bytes. A count-only limit lets a
        // peer retain up to 64 maximum-sized frames per socket before any rate check.
        if (queuedFrames >= MAX_QUEUED_FRAMES_PER_SOCKET ||
            queuedFrameBytes + frame.length > this.maxFrameBytes * MAX_QUEUED_FRAME_BYTES_PER_SOCKET) {
          socket.destroy(); return;
        }
        queuedFrames++;
        queuedFrameBytes += frame.length;
        // Serialize handler execution and cap queued work per socket. Without this, a
        // fast peer can create an unbounded number of concurrent async handler calls.
        processing = processing
          .then(() => socket.destroyed ? undefined : this.#processFrame(socket, frame))
          .catch(() => socket.destroy())
          .finally(() => { queuedFrames--; queuedFrameBytes -= frame.length; });
        if (socket.destroyed) return;
      }
      if (pending.length > this.maxFrameBytes) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.connections.delete(socket);
      // Socket IDs are unique per connection; release their bucket immediately instead of
      // retaining churned connections until the limiter's idle TTL expires.
      this.socketRateLimiter.forget?.(session.id);
    });
    if (this.genesis) this.#sendHandshake(socket, { type: 'ZION_HANDSHAKE', networkId: this.networkId, protocolMajor: this.genesis.protocolMajor, nonce: session.localNonce });
  }

  /** Open an authenticated-message TCP connection and attach the inbound frame parser. */
  async connect(host, port) {
    if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid peer address');
    if (!isLoopbackAddress(host) && !this.tlsOptions) throw new Error('Remote peer connections require mutual TLS; plaintext TCP is restricted to loopback IP literals');
    if (this.connections.size >= this.maxConnections) throw new Error('Connection capacity reached');
    const useTls = Boolean(this.tlsOptions);
    const socket = useTls
      ? createTlsConnection({ ...this.tlsOptions, host, port, servername: netIsIpAddress(host) ? undefined : (this.tlsOptions.servername ?? host), rejectUnauthorized: true, minVersion: 'TLSv1.2' })
      : createConnection({ host, port });
    await new Promise((resolve, reject) => {
      // A TCP 'connect' event does not mean the TLS peer has been authenticated.
      // Bound the outbound connection/handshake too: server-side TLS timeouts do
      // not protect clients connecting to an unresponsive or malicious endpoint.
      const readyEvent = useTls ? 'secureConnect' : 'connect';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.off('error', onError);
        socket.off(readyEvent, onReady);
        socket.destroy();
        reject(new Error(useTls ? 'TLS handshake timed out' : 'Peer connection timed out'));
      }, this.tlsHandshakeTimeoutMs);
      const onError = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.off(readyEvent, onReady); reject(error);
      };
      const onReady = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.off('error', onError); resolve();
      };
      socket.once('error', onError); socket.once(readyEvent, onReady);
    });
    if (this.connections.size >= this.maxConnections) { socket.destroy(); throw new Error('Connection capacity reached'); }
    this.#attach(socket);
    return socket;
  }

  #sendHandshake(socket, payload) {
    const handshakePayload = payload?.type === 'ZION_HANDSHAKE' && this.admissionVouchers.length
      ? { ...payload, vouchers: this.admissionVouchers } : payload;
    const signed = signPeerMessage(this.identity, handshakePayload, { now: this.now() });
    const frame = Buffer.from(`${JSON.stringify(signed)}\n`);
    if (frame.length > this.maxFrameBytes) { socket.destroy(); return; }
    socket.write(frame);
  }

  async #processFrame(socket, frame) {
    // Apply the cheap socket budget before parsing attacker-controlled JSON, checking integrity state,
    // deriving public keys, or verifying signatures. Frame length was already bounded by the parser.
    if (!(await this.#admitWithinRate(socket, this.socketRateLimiter, socket.__zionSession?.id ?? 'socket'))) { socket.destroy(); return; }
    if (this.networkMode === 'official') await this.integrityGuard.checkHealthy();
    let message;
    try { message = JSON.parse(frame.toString('utf8')); }
    catch { socket.destroy(); return; }
    const checked = verifyPeerMessage(message, { now: this.now(), maxBytes: this.maxFrameBytes });
    if (!checked.ok) { socket.destroy(); return; }
    const trustedByAllowlist = !this.trustedPeerIds || this.trustedPeerIds.has(checked.nodeId);
    if (!trustedByAllowlist && !this.admissionController) { socket.destroy(); return; }
    // Enforce the peer tier before any potentially remote/transactional admission lookup.
    // Otherwise a validly signed pre-handshake flood can still force one backend read per frame.
    const tierLimiter = socket.__zionSession?.authenticated ? this.rateLimiter : this.unauthenticatedRateLimiter;
    if (!(await this.#admitWithinRate(socket, tierLimiter, checked.nodeId))) { socket.destroy(); return; }
    if (!this.replayGuard.accept(message, this.now())) { socket.destroy(); return; }
    let payloadBytes;
    try { payloadBytes = Buffer.byteLength(JSON.stringify(checked.payload), 'utf8'); }
    catch { socket.destroy(); return; }
    if (payloadBytes > this.maxMessageBytes || !checked.payload || typeof checked.payload !== 'object' || Array.isArray(checked.payload)) { socket.destroy(); return; }
    if (this.genesis && !socket.__zionSession?.authenticated) {
      const session = socket.__zionSession; const payload = checked.payload;
      if (payload?.type === 'ZION_HANDSHAKE' && payload.networkId === this.networkId &&
          payload.protocolMajor === this.genesis.protocolMajor && typeof payload.nonce === 'string' && /^[a-f0-9]{64}$/.test(payload.nonce) &&
          payload.nonce !== session.localNonce && (!session.remoteNonce || session.remoteNonce === payload.nonce)) {
        // Admission state is only needed for a new handshake. Avoid a remote/transactional
        // store read for every authenticated application frame from an already connected peer.
        const previouslyAdmitted = this.admittedPeerIds.has(checked.nodeId) ||
          (this.admissionController ? await this.admissionController.isAdmitted(checked.nodeId) === true : false);
        if (!trustedByAllowlist && !previouslyAdmitted) {
          let admission;
          try { admission = await this.admissionController.admit({ subjectNodeId: checked.nodeId, vouchers: payload.vouchers }); }
          catch { socket.destroy(); return; }
          const admittedAfterAttempt = await this.admissionController.isAdmitted(checked.nodeId);
          if (!admission?.ok && !admittedAfterAttempt) { socket.destroy(); return; }
          this.admittedPeerIds.add(checked.nodeId);
        }
        session.remoteNonce = payload.nonce;
        this.#sendHandshake(socket, { type: 'ZION_HANDSHAKE_ACK', networkId: this.networkId, protocolMajor: this.genesis.protocolMajor, nonce: session.localNonce, echo: session.remoteNonce });
        return;
      }
      if (payload?.type === 'ZION_HANDSHAKE_ACK' && payload.networkId === this.networkId &&
          payload.protocolMajor === this.genesis.protocolMajor && payload.echo === session.localNonce &&
          typeof payload.nonce === 'string' && payload.nonce === session.remoteNonce) {
        session.authenticated = true;
        return;
      }
      socket.destroy(); return;
    }
    if (this.genesis && (checked.payload?.type === 'ZION_HANDSHAKE' || checked.payload?.type === 'ZION_HANDSHAKE_ACK')) { socket.destroy(); return; }
    if (!this.allowedTypes.has(checked.payload?.type)) { socket.destroy(); return; }
    if (this.networkMode === 'official') {
      const operation = validateProtocolOperation(checked.payload, { genesis: this.genesis, now: this.now() });
      if (!operation.ok) { socket.destroy(); return; }
    }
    try {
      await this.onMessage(Object.freeze({ nodeId: checked.nodeId, payload: checked.payload, envelope: message }), socket);
    } catch {
      // Fail closed on handler errors; do not leak internal error details to peers.
      socket.destroy();
    }
  }

  /**
   * Rate limiting by backpressure: when a peer is briefly over its budget, stop reading from its socket (TCP
   * flow control slows the sender) and retry once tokens refill, instead of dropping an honest bulk transfer.
   * The wait is bounded and the socket idle timeout still applies; a limiter that cannot predict a refill time
   * (or one that needs longer than MAX_THROTTLE_MS) keeps the previous fail-closed behaviour of disconnecting.
   */
  async #admitWithinRate(socket, limiter, nodeId) {
    if (limiter.allow(nodeId)) return true;
    if (typeof limiter.retryAfterMs !== 'function') return false;
    const session = socket.__zionSession;
    for (let attempt = 0; attempt < MAX_THROTTLE_WAITS; attempt++) {
      const waitMs = limiter.retryAfterMs(nodeId);
      if (!Number.isFinite(waitMs) || waitMs > MAX_THROTTLE_MS || socket.destroyed) return false;
      session.throttled = (session.throttled ?? 0) + 1;
      socket.pause();
      await new Promise(resolve => setTimeout(resolve, Math.max(1, waitMs)));
      session.throttled -= 1;
      if (session.throttled === 0 && !socket.destroyed) socket.resume();
      if (socket.destroyed) return false;
      if (limiter.allow(nodeId)) return true;
    }
    return false;
  }

  send(socket, payload) {
    if (this.networkMode === 'official') this.integrityGuard.assertHealthy();
    if (!socket || socket.destroyed || !socket.writable) throw new Error('Peer socket is not writable');
    if (this.genesis && !socket.__zionSession?.authenticated) throw new Error('Protocol handshake has not completed');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string' || !this.allowedTypes.has(payload.type)) throw new TypeError('Unsupported protocol message type');
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > this.maxMessageBytes) throw new RangeError('Protocol message exceeds configured genesis limit');
    if (this.networkMode === 'official') {
      const operation = validateProtocolOperation(payload, { genesis: this.genesis, now: this.now() });
      if (!operation.ok) throw new TypeError(`Invalid official protocol operation: ${operation.reason}`);
    }
    const signed = signPeerMessage(this.identity, payload, { now: this.now() });
    const frame = Buffer.from(`${JSON.stringify(signed)}\n`);
    if (frame.length > this.maxFrameBytes) throw new RangeError('Protocol frame too large');
    if (this.transferScheduler) return this.transferScheduler.enqueue(socket, frame);
    return socket.write(frame);
  }

  #isolateForIntegrityFailure(_reason) {
    // Stop accepting peers first, then terminate established sessions. Do not rely on
    // the next send/receive operation to notice quarantine.
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server?.listening) {
      try { this.server.close(() => {}); } catch { /* quarantine remains fail-closed */ }
    }
    this.started = false;
  }

  async close() {
    this.removeQuarantineListener?.();
    this.removeQuarantineListener = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server?.listening) await new Promise((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    this.started = false;
  }
}
