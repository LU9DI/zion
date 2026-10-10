/** Deterministic advisory placement planner. It never claims a replica exists. */
export function planReplicas({ chunkId, nodes, replicaCount = 3, excludedNodeIds = [] }) {
  if (!/^[a-f0-9]{64}$/.test(chunkId)) throw new TypeError('chunkId must be a SHA-256 hex digest');
  if (!Number.isInteger(replicaCount) || replicaCount < 1) throw new RangeError('replicaCount must be >= 1');
  const excluded = new Set(excludedNodeIds);
  const candidates = nodes.filter(n => n && typeof n.id === 'string' && !excluded.has(n.id) &&
    n.online === true && n.acceptingStorage === true && n.quarantined !== true &&
    (n.integrityStatus === undefined || n.integrityStatus === 'verified') &&
    n.availableBytes > 0 && n.resourceBudget?.enabled === true && Number.isFinite(n.availableBytes));
  // Stable rendezvous-style ranking spreads a chunk across node identities.
  candidates.sort((a, b) => {
    const score = id => BigInt(`0x${createScore(chunkId, id)}`);
    const sa = score(a.id), sb = score(b.id);
    return sa > sb ? -1 : sa < sb ? 1 : a.id.localeCompare(b.id);
  });
  const selected = [];
  const domains = new Set();
  for (const n of candidates) {
    const domain = n.failureDomain || n.id;
    if (domains.has(domain)) continue;
    selected.push({ nodeId: n.id, failureDomain: domain });
    domains.add(domain);
    if (selected.length >= replicaCount) break;
  }
  return Object.freeze({ chunkId, desiredReplicas: replicaCount, placements: selected, underReplicated: selected.length < replicaCount });
}
function createScore(chunkId, nodeId) {
  // Avoid external crypto dependency; a deterministic FNV-style score is only for placement, not security.
  let h = 0xcbf29ce484222325n;
  for (const c of `${chunkId}:${nodeId}`) { h ^= BigInt(c.codePointAt(0)); h = BigInt.asUintN(64, h * 0x100000001b3n); }
  return h.toString(16).padStart(16, '0');
}
