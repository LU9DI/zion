import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeIdentity } from '../src/peer-security.js';
import { PeerTransport } from '../src/peer-transport.js';

function waitFor(predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for peer message'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('transport accepts a valid signed peer message and exposes authenticated identity', async t => {
  let received;
  const server = new PeerTransport({ identity: createNodeIdentity(), onMessage: async message => { received = message; } });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: createNodeIdentity() });
  const socket = connect(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  client.send(socket, { type: 'PING', nonce: 'test' });
  await waitFor(() => Boolean(received));
  assert.equal(received.nodeId, client.identity.nodeId);
  assert.deepEqual(received.payload, { type: 'PING', nonce: 'test' });
});

test('transport refuses plaintext outbound connections to non-loopback peers', async () => {
  const client = new PeerTransport({ identity: createNodeIdentity() });
  await assert.rejects(client.connect('192.0.2.10', 443), /require mutual TLS/);
  await assert.rejects(client.connect('localhost', 443), /require mutual TLS/);
  await assert.rejects(client.connect('::ffff:192.0.2.10', 443), /require mutual TLS/);
  await client.close();
});

test('transport rejects unsupported message types before sending', async t => {
  const client = new PeerTransport({ identity: createNodeIdentity() });
  const socket = { destroyed: false, writable: true, write() { throw new Error('should not write'); } };
  assert.throws(() => client.send(socket, { type: 'RUN_REMOTE_CODE' }), /Unsupported protocol message type/);
});

test('transport defaults to loopback and bounds frames', async t => {
  const server = new PeerTransport({ identity: createNodeIdentity(), maxFrameBytes: 512 });
  assert.equal(server.host, '127.0.0.1');
  assert.equal(server.maxFrameBytes, 512);
  await server.listen();
  await server.close();
});

test('transport serializes async handlers and bounds queued frames per socket', async t => {
  let release;
  let entered = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const server = new PeerTransport({
    identity: createNodeIdentity(),
    onMessage: async () => {
      entered++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (entered === 1) await blocked;
      concurrent--;
    }
  });
  const address = await server.listen();
  t.after(async () => { release(); await server.close(); });
  const client = new PeerTransport({ identity: createNodeIdentity() });
  const socket = connect(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  for (let i = 0; i < 70; i++) client.send(socket, { type: 'PING', nonce: String(i) });
  await waitFor(() => socket.destroyed || entered > 0);
  assert.equal(maxConcurrent, 1);
  assert.equal(socket.destroyed, true, 'socket is closed when its per-connection work queue overflows');
});


test('transport applies rate limiting before replay-cache admission', async t => {
  const replayGuard = {
    accepted: 0,
    accept() { this.accepted++; return true; }
  };
  const rateLimiter = { allow() { return false; } };
  const server = new PeerTransport({ identity: createNodeIdentity(), replayGuard, rateLimiter });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: createNodeIdentity() });
  const socket = connect(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  client.send(socket, { type: 'PING', nonce: 'rate-limited' });
  await waitFor(() => socket.destroyed);
  assert.equal(replayGuard.accepted, 0, 'rate-limited messages must not consume replay-cache entries');
});


test('non-loopback binding requires an explicit trusted peer allowlist', () => {
  assert.doesNotThrow(() => new PeerTransport({ identity: createNodeIdentity(), host: '127.0.0.2' }));
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), host: '127.999.1.1' }), /trustedPeerIds allowlist/);
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), host: '0.0.0.0' }), /trustedPeerIds allowlist/);
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), host: '0.0.0.0', trustedPeerIds: ['bad-id'] }), /trustedPeerIds/);
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), host: '0.0.0.0', trustedPeerIds: ['a'.repeat(64)] }), /mutual TLS options/);
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), host: '0.0.0.0', trustedPeerIds: ['a'.repeat(64)], tlsOptions: { key: '', cert: '', ca: [] } }), /mutual TLS options/);
  assert.doesNotThrow(() => new PeerTransport({ identity: createNodeIdentity(), host: '0.0.0.0', trustedPeerIds: ['a'.repeat(64)], tlsOptions: { key: 'test-key', cert: 'test-cert', ca: 'test-ca' } }));
});

test('transport rejects a correctly signed message from an identity outside the trust allowlist', async t => {
  const untrustedIdentity = createNodeIdentity();
  const server = new PeerTransport({ identity: createNodeIdentity(), trustedPeerIds: ['a'.repeat(64)] });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: untrustedIdentity });
  const socket = connect(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  client.send(socket, { type: 'PING', nonce: 'untrusted-peer' });
  await waitFor(() => socket.destroyed);
});

test('transport routes outbound signed frames through adaptive bandwidth scheduler when configured', async t => {
  const { AdaptiveBandwidthPolicy } = await import('../src/adaptive-bandwidth-policy.js');
  const { AdaptiveTransferScheduler } = await import('../src/adaptive-transfer-scheduler.js');
  let received;
  const server = new PeerTransport({ identity: createNodeIdentity(), onMessage: async message => { received = message; } });
  const address = await server.listen();
  t.after(() => server.close());
  const policy = new AdaptiveBandwidthPolicy({ maxUploadKiBps: 20, activeUploadFraction: 1, activeDownloadFraction: 1 });
  const scheduler = new AdaptiveTransferScheduler({ policy, getTelemetry: () => ({ telemetryHealthy: true, userActive: true, networkBusy: 0, measuredUploadKiBps: 20, measuredDownloadKiBps: 20 }) });
  const client = new PeerTransport({ identity: createNodeIdentity(), transferScheduler: scheduler });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(() => { socket.destroy(); scheduler.close(); });
  const result = await client.send(socket, { type: 'PING', nonce: 'scheduled' });
  await waitFor(() => Boolean(received));
  assert.equal(received.nodeId, client.identity.nodeId);
  assert.equal(received.payload.nonce, 'scheduled');
  assert.ok(result.bytes > 0);
  assert.ok(result.uploadKiBps <= 20);
});

function testGenesis(name = 'Zion test network') {
  return {
    schemaVersion: 1, networkName: name, protocolMajor: 1, genesisTime: 1800000000,
    serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 32, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true }
  };
}

test('genesis-enabled peers authenticate a challenge-response handshake before application messages', async t => {
  let received;
  const genesis = testGenesis();
  const server = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: genesis, onMessage: async message => { received = message; } });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: genesis });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(() => socket.destroy());
  await waitFor(() => socket.__zionSession?.authenticated && [...server.connections][0]?.__zionSession?.authenticated);
  client.send(socket, { type: 'PING', nonce: 'genesis-handshake' });
  await waitFor(() => Boolean(received));
  assert.equal(received.payload.nonce, 'genesis-handshake');
});

test('genesis-enabled peers reject different network IDs before application messages', async t => {
  const server = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: testGenesis('Zion A') });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: testGenesis('Zion B') });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(() => socket.destroy());
  await waitFor(() => socket.destroyed || [...server.connections].every(peer => peer.destroyed));
  assert.equal(socket.destroyed, true);
});

test('genesis-enabled peers cannot send application messages before handshake', async () => {
  const transport = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: testGenesis() });
  const socket = { destroyed: false, writable: true, __zionSession: { authenticated: false }, write() { throw new Error('must not write'); } };
  assert.throws(() => transport.send(socket, { type: 'PING' }), /handshake has not completed/);
});


test('official network mode requires genesis and applies genesis message limits', async () => {
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), networkMode: 'official' }), /requires a reviewed protocol genesis/);
  const genesis = testGenesis();
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), networkMode: 'official', protocolGenesis: genesis, maxFrameBytes: genesis.limits.maxFrameBytes + 1 }), /exceeds protocol genesis/);
  const integrityGuard = { async checkHealthy() {}, assertHealthy() {} };
  const transport = new PeerTransport({ identity: createNodeIdentity(), networkMode: 'official', protocolGenesis: genesis, integrityGuard });
  const socket = { destroyed: false, writable: true, __zionSession: { authenticated: true }, write() { return true; } };
  assert.throws(() => transport.send(socket, { type: 'PING', value: 'x'.repeat(genesis.limits.maxMessageBytes) }), /exceeds configured genesis limit/);
  await transport.close();
});

test('official mode rejects malformed application operations before sending', async () => {
  const integrityGuard = { async checkHealthy() {}, assertHealthy() {} };
  const transport = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: testGenesis(), networkMode: 'official', integrityGuard });
  const socket = { destroyed: false, writable: true, __zionSession: { authenticated: true }, write() { throw new Error('invalid operation must not be sent'); } };
  assert.throws(() => transport.send(socket, { type: 'PING' }), /Invalid official protocol operation: invalid-ping-nonce/);
  assert.throws(() => transport.send(socket, { type: 'RUN_CODE', code: 'bad' }), /Unsupported protocol message type/);
  await transport.close();
});

test('official transport immediately closes peer sessions and stops listening on integrity quarantine', async t => {
  const listeners = new Set();
  const integrityGuard = {
    status: { verified: true, quarantined: false, reason: null },
    async checkHealthy() { if (this.status.quarantined) throw Object.assign(new Error('quarantined'), { code: 'ZION_INTEGRITY_QUARANTINED' }); },
    assertHealthy() { if (this.status.quarantined) throw Object.assign(new Error('quarantined'), { code: 'ZION_INTEGRITY_QUARANTINED' }); },
    addQuarantineListener(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const transport = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: testGenesis(), networkMode: 'official', integrityGuard });
  const address = await transport.listen();
  const client = new PeerTransport({ identity: createNodeIdentity() });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(async () => { await client.close(); await transport.close(); });
  await waitFor(() => transport.connections.size === 1);
  assert.equal(transport.server.listening, true);
  integrityGuard.status = { verified: false, quarantined: true, reason: 'hash-mismatch:src/peer-transport.js' };
  for (const listener of listeners) await listener({ reason: integrityGuard.status.reason });
  await waitFor(() => socket.destroyed && transport.connections.size === 0 && !transport.server.listening);
  assert.equal(transport.started, false);
  assert.throws(() => transport.send(socket, { type: 'PING', nonce: 'after-quarantine' }), /ZION_INTEGRITY_QUARANTINED|not writable|quarantined/);
});

test('three-node isolation quarantines only the compromised node while healthy peers continue communicating', async t => {
  const makeGuard = () => {
    const listeners = new Set();
    return {
      status: { verified: true, quarantined: false, reason: null },
      async checkHealthy() {
        if (this.status.quarantined) throw Object.assign(new Error('quarantined'), { code: 'ZION_INTEGRITY_QUARANTINED' });
      },
      assertHealthy() {
        if (this.status.quarantined) throw Object.assign(new Error('quarantined'), { code: 'ZION_INTEGRITY_QUARANTINED' });
      },
      addQuarantineListener(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async quarantine(reason) {
        this.status = { verified: false, quarantined: true, reason };
        for (const listener of listeners) await listener({ reason });
      }
    };
  };
  const genesis = testGenesis('Zion three-node isolation');
  let healthyMessage;
  const guardA = makeGuard();
  const guardB = makeGuard();
  const guardC = makeGuard();
  const nodeA = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: genesis, networkMode: 'official', integrityGuard: guardA });
  const nodeB = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: genesis, networkMode: 'official', integrityGuard: guardB });
  const nodeC = new PeerTransport({ identity: createNodeIdentity(), protocolGenesis: genesis, networkMode: 'official', integrityGuard: guardC,
    onMessage: async message => { if (message.payload.type === 'PING') healthyMessage = message; } });
  const [addressA, addressB, addressC] = await Promise.all([nodeA.listen(), nodeB.listen(), nodeC.listen()]);
  t.after(async () => { await Promise.all([nodeA.close(), nodeB.close(), nodeC.close()]); });
  const aToB = await nodeA.connect('127.0.0.1', addressB.port);
  const cToB = await nodeC.connect('127.0.0.1', addressB.port);
  const aToC = await nodeA.connect('127.0.0.1', addressC.port);
  await waitFor(() => aToB.__zionSession?.authenticated && cToB.__zionSession?.authenticated && aToC.__zionSession?.authenticated &&
    [...nodeB.connections].length === 2 && [...nodeC.connections].some(socket => socket.__zionSession?.authenticated));

  await guardB.quarantine('hash-mismatch:src/peer-transport.js');
  await waitFor(() => aToB.destroyed && cToB.destroyed && nodeB.connections.size === 0 && !nodeB.server.listening);
  assert.equal(aToC.destroyed, false, 'healthy A-C session must not be closed by B quarantine');
  nodeA.send(aToC, { type: 'PING', nonce: 'healthy-after-isolation' });
  await waitFor(() => Boolean(healthyMessage));
  assert.equal(healthyMessage.nodeId, nodeA.identity.nodeId);
  assert.equal(healthyMessage.payload.nonce, 'healthy-after-isolation');
  assert.equal(nodeA.started, true);
  assert.equal(nodeC.started, true);
  assert.equal(nodeB.started, false);
});


let opensslAvailable = false;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); opensslAvailable = true; } catch { /* integration test is skipped on hosts without OpenSSL */ }

function createTlsTestMaterial(directory) {
  const run = args => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Zion Test CA', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'wrong-ca.key', '-out', 'wrong-ca.crt', '-subj', '/CN=Untrusted Zion Test CA', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  for (const role of ['server', 'client']) {
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', role + '.key', '-out', role + '.csr', '-subj', '/CN=' + (role === 'server' ? 'localhost' : 'zion-test-client')]);
    const extensions = role === 'server'
      ? 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n'
      : 'basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n';
    writeFileSync(join(directory, role + '.ext'), extensions);
    run(['x509', '-req', '-in', role + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', role + '.crt', '-days', '2', '-sha256', '-extfile', role + '.ext']);
  }
  const read = name => readFileSync(join(directory, name));
  return {
    ca: read('ca.crt'),
    server: { key: read('server.key'), cert: read('server.crt'), ca: read('ca.crt') },
    client: { key: read('client.key'), cert: read('client.crt'), ca: read('ca.crt') },
    untrustedClient: { key: read('client.key'), cert: read('client.crt'), ca: read('wrong-ca.crt') }
  };
}

test('mutual TLS peer transport completes a real verified handshake and exchanges signed messages', { skip: !opensslAvailable }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-mtls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const material = createTlsTestMaterial(directory);
  let received;
  const server = new PeerTransport({
    identity: createNodeIdentity(),
    host: '127.0.0.1',
    tlsOptions: material.server,
    onMessage: async message => { received = message; }
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: createNodeIdentity(), tlsOptions: material.client });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(async () => { socket.destroy(); await client.close(); });
  client.send(socket, { type: 'PING', nonce: 'verified-mtls' });
  await waitFor(() => Boolean(received));
  assert.equal(received.payload.nonce, 'verified-mtls');
});

test('mutual TLS rejects a server certificate signed by an untrusted CA', { skip: !opensslAvailable }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-mtls-untrusted-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const material = createTlsTestMaterial(directory);
  const server = new PeerTransport({ identity: createNodeIdentity(), host: '127.0.0.1', tlsOptions: material.server });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({ identity: createNodeIdentity(), tlsOptions: material.untrustedClient });
  await assert.rejects(client.connect('127.0.0.1', address.port), /certificate|issuer|self-signed|verify/i);
  await client.close();
});


test('localhost bind requires TLS because resolver aliases are not trusted as loopback literals', () => {
  assert.throws(() => new PeerTransport({ identity: createNodeIdentity(), host: 'localhost', trustedPeerIds: ['a'.repeat(64)] }), /requires mutual TLS/);
});


test('outbound TLS handshake timeout closes an unresponsive peer', { skip: !opensslAvailable }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zion-mtls-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const material = createTlsTestMaterial(directory);
  const stalledServer = createTcpServer(() => { /* accept TCP but never perform TLS handshake */ });
  stalledServer.listen(0, '127.0.0.1');
  await once(stalledServer, 'listening');
  t.after(() => stalledServer.close());
  const address = stalledServer.address();
  const client = new PeerTransport({ identity: createNodeIdentity(), tlsOptions: material.client, tlsHandshakeTimeoutMs: 150 });
  const started = Date.now();
  await assert.rejects(client.connect('127.0.0.1', address.port), /TLS handshake timed out/);
  assert.ok(Date.now() - started < 1500, 'stalled handshake must be bounded');
  await client.close();
});

test('official transport honors persistent admission revocation over its local cache', async t => {
  const seed = createNodeIdentity();
  const newcomer = createNodeIdentity();
  const guard = {
    status: { verified: true, quarantined: false },
    async checkHealthy() {},
    assertHealthy() {},
    addQuarantineListener: () => () => {},
  };
  const admissionController = {
    async admit() { return { ok: false, reason: 'subject-not-admitted' }; },
    async isAdmitted() { return false; },
    async releaseAdmission() {},
  };
  const server = new PeerTransport({
    identity: seed,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: ['a'.repeat(64)],
    admissionController,
  });
  // Simulate stale process-local state after an operator releases the admission.
  server.admittedPeerIds.add(newcomer.nodeId);
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({
    identity: newcomer,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: [seed.nodeId],
  });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(async () => { socket.destroy(); await client.close(); });
  await waitFor(() => socket.destroyed);
  assert.equal(server.admittedPeerIds.has(newcomer.nodeId), true, 'test keeps stale cache to prove it cannot override database state');
});

test('official transport closes a peer when authoritative admission reads fail', async t => {
  const seed = createNodeIdentity();
  const newcomer = createNodeIdentity();
  const guard = {
    status: { verified: true, quarantined: false },
    async checkHealthy() {},
    assertHealthy() {},
    addQuarantineListener: () => () => {},
  };
  const admissionController = {
    async admit() { return { ok: false, reason: 'admission-state-unavailable' }; },
    async isAdmitted() { throw new Error('database unavailable'); },
    async releaseAdmission() {},
  };
  const server = new PeerTransport({
    identity: seed,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: ['a'.repeat(64)],
    admissionController,
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({
    identity: newcomer,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: [seed.nodeId],
  });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(async () => { socket.destroy(); await client.close(); });
  await waitFor(() => socket.destroyed);
  assert.equal(server.admittedPeerIds.has(newcomer.nodeId), false);
});

test('official transport closes a peer when post-admission reconciliation read fails', async t => {
  const seed = createNodeIdentity();
  const issuer = createNodeIdentity();
  const newcomer = createNodeIdentity();
  const { createPeerIntroductionVoucher } = await import('../src/peer-introduction-vouchers.js');
  const guard = {
    status: { verified: true, quarantined: false },
    async checkHealthy() {},
    assertHealthy() {},
    addQuarantineListener: () => () => {},
  };
  let reads = 0;
  const admissionController = {
    async admit() { return { ok: false, reason: 'admission-state-unavailable' }; },
    async isAdmitted() {
      reads++;
      if (reads > 1) throw new Error('database unavailable after admission attempt');
      return false;
    },
    async releaseAdmission() {},
  };
  const server = new PeerTransport({
    identity: seed,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: [issuer.nodeId],
    admissionController,
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({
    identity: newcomer,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: [seed.nodeId],
    admissionVouchers: [],
  });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(async () => { socket.destroy(); await client.close(); });
  await waitFor(() => socket.destroyed);
  assert.equal(server.admittedPeerIds.has(newcomer.nodeId), false);
});

test('official transport admits an unknown peer only when its signed handshake carries valid invite vouchers', async t => {
  const { calculateNetworkId } = await import('../src/protocol-genesis.js');
  const { createPeerIntroductionVoucher } = await import('../src/peer-introduction-vouchers.js');
  const { PeerAdmissionController } = await import('../src/peer-admission-controller.js');
  const draft = {
    schemaVersion: 1, networkName: 'Zion Invite Test', protocolMajor: 1, genesisTime: 1_800_000_000,
    serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 16, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
  const genesis = { ...draft };
  const guard = {
    status: { quarantined: false },
    checkHealthy: async () => {},
    assertHealthy: () => {},
    addQuarantineListener: () => () => {},
  };
  const issuerA = createNodeIdentity(), issuerB = createNodeIdentity();
  const newcomer = createNodeIdentity(), seed = createNodeIdentity();
  const vouchers = [
    createPeerIntroductionVoucher({ issuerIdentity: issuerA, subjectNodeId: newcomer.nodeId }),
    createPeerIntroductionVoucher({ issuerIdentity: issuerB, subjectNodeId: newcomer.nodeId }),
  ];
  let state = null;
  const stateStore = { load: () => state === null ? null : structuredClone(state), save: next => { state = structuredClone(next); } };
  const admissionController = new PeerAdmissionController({
    trustedIssuerNodeIds: [issuerA.nodeId, issuerB.nodeId], threshold: 2, stateStore,
    capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 0.5 }),
  });
  let received = false;
  // Model a transactional/shared backend whose admission reads are asynchronous.
  const asyncReadController = {
    admit: input => admissionController.admit(input),
    isAdmitted: async nodeId => admissionController.isAdmitted(nodeId),
  };
  const server = new PeerTransport({
    identity: seed, host: '127.0.0.1', networkMode: 'official', protocolGenesis: genesis, integrityGuard: guard,
    trustedPeerIds: [issuerA.nodeId, issuerB.nodeId], admissionController: asyncReadController,
    onMessage: async message => { if (message.payload.type === 'PING') received = true; },
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({
    identity: newcomer, host: '127.0.0.1', networkMode: 'official', protocolGenesis: genesis, integrityGuard: guard,
    trustedPeerIds: [seed.nodeId], admissionVouchers: vouchers,
  });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(() => { socket.destroy(); client.close(); });
  await waitFor(() => server.admittedPeerIds.has(newcomer.nodeId));
  // Server-side admission may complete before the client's handshake response is
  // processed. Wait for the client session to authenticate before sending data.
  await waitFor(() => socket.__zionSession?.authenticated === true);
  client.send(socket, { type: 'PING', nonce: 'invite-admitted' });
  await waitFor(() => received);
  assert.equal(admissionController.isAdmitted(newcomer.nodeId), true);
});

test('official transport rejects an unknown peer with no valid invite vouchers', async t => {
  const { PeerAdmissionController } = await import('../src/peer-admission-controller.js');
  const genesis = {
    schemaVersion: 1, networkName: 'Zion Invite Reject Test', protocolMajor: 1, genesisTime: 1_800_000_000,
    serialization: 'canonical-json-v1',
    crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
    contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
    erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
    limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
    replay: { maxClockSkewMs: 120000, nonceBytes: 16, retentionMs: 120000 },
    rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true },
  };
  const guard = { status: { quarantined: false }, checkHealthy: async () => {}, assertHealthy: () => {}, addQuarantineListener: () => () => {} };
  const issuer = createNodeIdentity(), seed = createNodeIdentity(), newcomer = createNodeIdentity();
  let state = null;
  const admissionController = new PeerAdmissionController({
    trustedIssuerNodeIds: [issuer.nodeId], threshold: 1,
    stateStore: { load: () => state, save: next => { state = structuredClone(next); } },
    capacityProvider: async () => ({ activePeers: 0, maxPeers: 10, storageHeadroomRatio: 0.5 }),
  });
  const server = new PeerTransport({
    identity: seed, host: '127.0.0.1', networkMode: 'official', protocolGenesis: genesis, integrityGuard: guard,
    trustedPeerIds: [issuer.nodeId], admissionController,
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({
    identity: newcomer, host: '127.0.0.1', networkMode: 'official', protocolGenesis: genesis, integrityGuard: guard,
    trustedPeerIds: [seed.nodeId],
  });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(() => { socket.destroy(); client.close(); });
  await waitFor(() => socket.destroyed);
  assert.equal(admissionController.isAdmitted(newcomer.nodeId), false);
});

test('official transport closes an established session immediately after persistent admission revocation', async t => {
  const seed = createNodeIdentity();
  const newcomer = createNodeIdentity();
  const guard = {
    status: { verified: true, quarantined: false },
    async checkHealthy() {},
    assertHealthy() {},
    addQuarantineListener: () => () => {},
  };
  let admitted = true;
  const admissionController = {
    async admit() { return { ok: true }; },
    async isAdmitted(nodeId) { return nodeId === newcomer.nodeId && admitted; },
    async releaseAdmission() { admitted = false; return { ok: true }; },
  };
  const server = new PeerTransport({
    identity: seed,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: [seed.nodeId],
    admissionController,
    onMessage: async () => {},
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = new PeerTransport({
    identity: newcomer,
    networkMode: 'official',
    protocolGenesis: testGenesis(),
    integrityGuard: guard,
    trustedPeerIds: [seed.nodeId],
  });
  const socket = await client.connect('127.0.0.1', address.port);
  t.after(async () => { socket.destroy(); await client.close(); });
  await waitFor(() => socket.__zionSession?.authenticated && [...server.connections].some(peer => peer.__zionSession?.authenticated));
  admitted = false;
  client.send(socket, { type: 'PING', nonce: 'after-revocation' });
  await waitFor(() => socket.destroyed);
});
