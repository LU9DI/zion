import { createNodeIdentity } from '../../src/peer-security.js';
import { PeerTransport } from '../../src/peer-transport.js';

const listeners = new Set();
const guard = {
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

const genesis = {
  schemaVersion: 1, networkName: 'Zion isolated-process integration', protocolMajor: 1, genesisTime: 1800000000,
  serialization: 'canonical-json-v1',
  crypto: { identity: 'Ed25519', signature: 'Ed25519', hash: 'SHA-256', aead: 'AES-256-GCM' },
  contentAddress: { algorithm: 'SHA-256', encoding: 'lowercase-hex' },
  erasureCoding: { algorithm: 'Reed-Solomon', dataShards: 10, parityShards: 20 },
  limits: { maxFrameBytes: 262144, maxMessageBytes: 262144, maxTtlMs: 600000, maxHops: 16 },
  replay: { maxClockSkewMs: 120000, nonceBytes: 32, retentionMs: 120000 },
  rules: { gossipIsDiscoveryOnly: true, localResourceLimitsAreAuthoritative: true, breakingChangesRequireNewNetwork: true }
};

const received = [];
const transport = new PeerTransport({
  identity: createNodeIdentity(), protocolGenesis: genesis, networkMode: 'official', integrityGuard: guard,
  onMessage: async message => {
    received.push(message.payload);
    if (process.send) process.send({ event: 'received', payload: message.payload, nodeId: message.nodeId });
  }
});
const sockets = new Map();
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for process peer handshake');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

process.on('message', async command => {
  try {
    let result;
    switch (command.action) {
      case 'listen': {
        result = await transport.listen();
        break;
      }
      case 'connect': {
        const socket = await transport.connect('127.0.0.1', command.port);
        sockets.set(command.name, socket);
        await waitFor(() => socket.__zionSession?.authenticated);
        result = { connected: true, name: command.name };
        break;
      }
      case 'send': {
        const socket = sockets.get(command.name);
        if (!socket) throw new Error(`Unknown socket: ${command.name}`);
        transport.send(socket, { type: 'PING', nonce: command.nonce });
        result = { sent: true };
        break;
      }
      case 'quarantine': {
        await guard.quarantine(command.reason ?? 'test-integrity-failure');
        result = { quarantined: true, listening: Boolean(transport.server?.listening), connections: transport.connections.size };
        break;
      }
      case 'status': {
        result = { quarantined: guard.status.quarantined, listening: Boolean(transport.server?.listening), connections: transport.connections.size, started: transport.started };
        break;
      }
      case 'close': {
        await transport.close();
        result = { closed: true };
        break;
      }
      default: throw new Error(`Unknown action: ${command.action}`);
    }
    if (process.send) process.send({ id: command.id, ok: true, result });
  } catch (error) {
    if (process.send) process.send({ id: command.id, ok: false, error: error.message, code: error.code });
  }
});

process.on('disconnect', async () => {
  try { await transport.close(); } finally { process.exit(0); }
});
