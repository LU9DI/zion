import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Fetches many content-addressed ciphertext chunks concurrently from several peers.
 *
 * Throughput of one connection is bounded by per-frame signing/verification, so reading in parallel
 * (several chunks in flight per peer, spread over distinct peers) is how aggregate speed scales.
 * Security properties are unchanged: every chunk is re-hashed against its chunkId before it is accepted,
 * a failing or lying peer is skipped for that chunk only, and in-flight work is bounded by both the caller's
 * concurrency and the storage service's own transfer/buffer limits (the service rejects more).
 *
 * `peers`: [{ nodeId, socket, quarantined?, integrityStatus? }].
 * `chunks`: chunkId strings, or { chunkId, peerIds } to restrict a chunk to the peers known to hold it. Prefer the
 * second form: a peer asked for a chunk it does not have drops the connection (the protocol has no not-found
 * reply), which also fails every other request in flight on that socket.
 * Resolves with an array of Buffers in the same order as `chunks`, or rejects with an AggregateError listing
 * every chunk that no peer could supply.
 */
export async function fetchChunksParallel({ transport, storageService, peers, chunks, concurrencyPerPeer = 2, timeoutMs = 10_000, signal } = {}) {
  if (!transport || typeof transport.send !== 'function' || !storageService || typeof storageService.fetchChunk !== 'function' || !Array.isArray(peers) || !Array.isArray(chunks) ||
    !Number.isSafeInteger(concurrencyPerPeer) || concurrencyPerPeer < 1 || concurrencyPerPeer > 16 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
    (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) ||
    chunks.some(entry => {
      if (typeof entry === 'string') return !SHA256.test(entry);
      if (!entry || typeof entry !== 'object' || !SHA256.test(entry.chunkId ?? '')) return true;
      return entry.peerIds !== undefined &&
        (!Array.isArray(entry.peerIds) || entry.peerIds.some(peerId => typeof peerId !== 'string' || !SHA256.test(peerId)));
    })) throw new TypeError('Invalid parallel fetch request');
  const wanted = chunks.map(entry => typeof entry === 'string' ? { chunkId: entry, peerIds: null } : { chunkId: entry.chunkId, peerIds: entry.peerIds === undefined ? null : new Set(entry.peerIds) });
  const seen = new Set();
  const usable = peers.filter(peer => {
    const ok = peer && typeof peer.nodeId === 'string' && SHA256.test(peer.nodeId) && peer.nodeId !== storageService.identity?.nodeId &&
      peer.socket && !peer.socket.destroyed && peer.socket.writable && !seen.has(peer.nodeId) &&
      peer.quarantined !== true && (peer.integrityStatus === undefined || peer.integrityStatus === 'verified');
    if (ok) seen.add(peer.nodeId);
    return ok;
  });
  const results = new Array(chunks.length);
  const triedBy = wanted.map(() => new Set());
  const failed = new Map();
  const queue = wanted.map(({ chunkId, peerIds }, index) => ({ chunkId, index, peerIds }));
  const eligible = (item, peer) => !triedBy[item.index].has(peer.nodeId) && (item.peerIds === null || item.peerIds.has(peer.nodeId));
  const candidatesFor = item => usable.filter(peer => item.peerIds === null || item.peerIds.has(peer.nodeId));
  let inFlight = 0; let wakeups = [];
  const wake = () => { const current = wakeups; wakeups = []; for (const resolve of current) resolve(); };
  const serviceCap = Math.max(1, Math.min(storageService.maxTransfers ?? Infinity,
    Math.floor((storageService.maxBufferedBytes ?? Infinity) / (storageService.maxChunkBytes ?? 1))));
  let slots = Math.min(usable.length * concurrencyPerPeer, serviceCap);
  const waiting = [];
  const acquire = () => slots > 0 ? (slots--, Promise.resolve()) : new Promise(resolve => waiting.push(resolve));
  const release = () => { const next = waiting.shift(); if (next) next(); else slots++; };

  const worker = async peer => {
    // Pull the next chunk this peer may serve. While other workers still have requests in flight a failure may
    // requeue a chunk, so an idle worker waits instead of exiting; it exits once nothing is left or in flight.
    for (;;) {
      if (signal?.aborted || peer.socket.destroyed || !peer.socket.writable) { wake(); return; }
      const position = queue.findIndex(item => eligible(item, peer));
      if (position === -1) {
        if (inFlight === 0) { wake(); return; }
        await new Promise(resolve => wakeups.push(resolve));
        continue;
      }
      const [item] = queue.splice(position, 1);
      inFlight++;
      await acquire();
      try {
        const envelope = await storageService.fetchChunk(transport, peer.socket, peer.nodeId, item.chunkId, { timeoutMs, signal });
        if (createHash('sha256').update(envelope).digest('hex') !== item.chunkId) throw new Error('Fetched chunk digest mismatch');
        results[item.index] = envelope;
      } catch (error) {
        triedBy[item.index].add(peer.nodeId);
        if (candidatesFor(item).every(candidate => triedBy[item.index].has(candidate.nodeId))) failed.set(item.chunkId, error);
        else queue.push(item);
      } finally { release(); inFlight--; wake(); }
    }
  };
  const workers = [];
  for (const peer of usable) for (let slot = 0; slot < concurrencyPerPeer; slot++) workers.push(worker(peer));
  await Promise.all(workers);
  if (signal?.aborted) throw Object.assign(new Error('Parallel chunk fetch aborted'), { name: 'AbortError' });
  const missing = wanted.filter((_, index) => results[index] === undefined).map(entry => entry.chunkId);
  if (missing.length) {
    throw new AggregateError(missing.map(id => failed.get(id) ?? new Error('No usable peer could supply the chunk')), `Could not fetch ${missing.length} chunk(s) from any peer`);
  }
  return results;
}
