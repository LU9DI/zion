import { createHash, randomBytes } from 'node:crypto';
import { PeerTransport } from '../src/peer-transport.js';
import { PeerRateLimiter, createNodeIdentity } from '../src/peer-security.js';
import { PeerStorageService } from '../src/peer-storage-service.js';

const MiB = 1024 * 1024;
const chunkBytes = Number(process.env.ZION_BENCH_CHUNK_BYTES ?? 4 * MiB);
const iterations = Number(process.env.ZION_BENCH_ITERATIONS ?? 3);
const relaxed = process.argv.includes('--relaxed');
if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 33 || chunkBytes > 64 * MiB) throw new RangeError('ZION_BENCH_CHUNK_BYTES must be between 33 bytes and 64 MiB');
if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) throw new RangeError('ZION_BENCH_ITERATIONS must be between 1 and 100');

const limiter = () => new PeerRateLimiter(relaxed
  ? { capacity: 10_000, refillPerSecond: 10_000 }
  : { capacity: 64, refillPerSecond: 20 });
const payload = Buffer.concat([Buffer.from('REAC1'), randomBytes(chunkBytes - 5)]);
const chunkId = createHash('sha256').update(payload).digest('hex');
const serverIdentity = createNodeIdentity();
const clientIdentity = createNodeIdentity();
const serverStore = { async get(id) {
  if (id !== chunkId) throw new Error('Unexpected benchmark chunk id');
  return Buffer.from(payload);
} };
const serverService = new PeerStorageService({
  identity: serverIdentity, store: serverStore, maxChunkBytes: chunkBytes, partBytes: 96 * 1024
});
const clientService = new PeerStorageService({
  identity: clientIdentity, store: {}, maxChunkBytes: chunkBytes, partBytes: 96 * 1024
});
let client;
const server = new PeerTransport({
  identity: serverIdentity, rateLimiter: limiter(),
  onMessage: (message, socket) => serverService.handle(message, socket, server)
});
client = new PeerTransport({
  identity: clientIdentity, rateLimiter: limiter(),
  onMessage: (message, socket) => clientService.handle(message, socket, client)
});
let socket;
try {
  const address = await server.listen();
  socket = await client.connect('127.0.0.1', address.port);
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = await clientService.fetchChunk(client, socket, serverIdentity.nodeId, chunkId, { timeoutMs: 120_000 });
    const elapsedMs = performance.now() - start;
    if (result.length !== payload.length || !result.equals(payload)) throw new Error('Benchmark transfer integrity check failed');
    result.fill(0);
    samples.push({ iteration: i + 1, elapsedMs: Number(elapsedMs.toFixed(2)), MiBps: Number((chunkBytes / MiB / (elapsedMs / 1000)).toFixed(2)) });
  }
  const totalMs = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
  console.log(JSON.stringify({
    mode: relaxed ? 'relaxed-token-bucket' : 'default-token-bucket',
    transport: 'TCP loopback, signed JSON/base64 frames, sequential 96 KiB segments',
    chunkBytes, iterations, totalMiB: Number((chunkBytes * iterations / MiB).toFixed(2)),
    elapsedMs: Number(totalMs.toFixed(2)),
    aggregateMiBps: Number((chunkBytes * iterations / MiB / (totalMs / 1000)).toFixed(2)),
    samples
  }, null, 2));
} finally {
  socket?.destroy();
  clientService.closePendingGets('Benchmark finished');
  await client.close();
  await server.close();
  payload.fill(0);
}
