# Fair use and anti-abuse policy

REA Cloud applies fair-use controls at multiple layers. These controls limit damage from one authenticated peer; they do not prove a real-world person has only one identity, and they are not a global consensus mechanism.

## Local personal-storage allowance

`FairSharePolicy` computes the local personal-storage allowance as:

`min(maxPersonalBytes, floor(verifiedContributionBytes * contributionRatio))`

The default ratio is 0.5 and the default absolute cap is 10 GiB. A user with 20 GiB of *verified eligible contribution* would therefore receive at most 10 GiB of personal storage under those defaults. Zero verified contribution yields zero quota. Deployments must call `setVerifiedContributionBytes` only with locally verified evidence; never accept this value from an unauthenticated peer or directly from a remote protocol message.

The policy reserves bytes before replication starts, so concurrent requests cannot all spend the same remaining quota. It also enforces daily byte/request limits and a concurrency ceiling. The default in-memory policy is suitable for tests and single-process experiments, not durable production enforcement. The coordinator releases a reservation if no replica is confirmed and commits the logical upload once at least one replica is confirmed.

## Per-peer admission control

`PeerAbuseGuard` can be supplied to `PeerStorageService` as `abuseGuard`. It applies a bounded peer table, daily accepted-byte and request limits, and per-peer concurrency limits. A rejected storage request returns `STORE_REJECTED` with `FAIR_USE_LIMIT`; the coordinator treats that as a failed placement and may try another eligible peer.

Example:

```js
import { PeerAbuseGuard } from './fair-share-policy.js';
import { PeerStorageService } from './peer-storage-service.js';

const abuseGuard = new PeerAbuseGuard({
  maxDailyBytesPerPeer: 2 * 1024 ** 3,
  maxDailyRequestsPerPeer: 2_000,
  maxConcurrentPerPeer: 4,
});
const service = new PeerStorageService({ identity, store, abuseGuard });
```

## Persistent per-peer accounting

For storage nodes that need usage counters to survive restarts, use `PersistentPeerAbuseGuard`. Call `await guard.init()` before accepting traffic, then pass it as `abuseGuard` to `PeerStorageService`. It serializes state updates with a local filesystem lock, atomically replaces a private JSON state file, persists daily request counts and committed bytes, and stores expiring reservations so a crashed process cannot hold concurrency forever. Corrupt state and lock timeouts fail closed.

```js
import { PersistentPeerAbuseGuard } from './fair-share-policy.js';
import { PeerStorageService } from './peer-storage-service.js';

const abuseGuard = await new PersistentPeerAbuseGuard('./.rea-data/abuse', {
  maxDailyBytesPerPeer: 2 * 1024 ** 3,
  maxDailyRequestsPerPeer: 2_000,
  maxConcurrentPerPeer: 4,
}).init();
const service = new PeerStorageService({ identity, store, abuseGuard });
```

This is a local, single-host accounting mechanism, not a globally agreed ledger. Keep the state directory private and on a filesystem with reliable atomic rename and locking semantics. Backup/restore or manual editing of the state can roll counters back; OS permissions and operational controls remain important.

## Important limitations

- The `FairSharePolicy` personal quota and the default `PeerAbuseGuard` are still in-memory. Use `PersistentPeerAbuseGuard` when per-peer admission counters must survive a process restart.
- `personalStoredBytes` is supplied by the local caller; it must come from a trusted local catalog and not user-controlled request data.
- The coordinator policy protects a client using this implementation. It does not globally prevent a malicious client from modifying its own software or creating multiple identities.
- Per-peer limits are enforced independently by each storage node, not by a global ledger. Sybil resistance requires additional design (e.g. resource-bounded admission, proof-of-replication/availability challenges, or an explicitly chosen trust/reputation model); no identity-only scheme can reliably equate public keys with people.
- Contribution credits are only as trustworthy as the evidence source. A signed storage receipt is a signed claim made after a write, not a permanent proof of continued possession. Do not count self-issued receipts as independent evidence of contribution.
- These application limits do not replace OS-enforced disk, CPU, memory, process, or network limits.

## Verified contribution credit (v0.21.0)

`PeerStorageService.refreshVerifiedContribution(policy)` now derives contribution credit from a fresh local inventory audit, not from peer-supplied declarations or old receipts. `OpaqueReplicaStore.auditInventory()` walks the expected content-addressed layout, rejects unexpected entries and symlinks, re-reads each stored envelope, validates its SHA-256 address and `REAC1` marker through `get()`, and returns the verified payload byte total. Only after the full audit succeeds does the service update `FairSharePolicy`; an audit error leaves existing credit unchanged and the caller should fail closed for any operation requiring refreshed credit. The scan is bounded by `maxEntries` (default 100,000) and serialized against cooperating store writes. This measures locally present, integrity-valid replica bytes at audit time; it is not proof of future availability, does not identify which human owns the remote content, and does not provide kernel-enforced disk limits. Call the refresh before calculating or granting personal-storage allowance and repeat it according to a conservative local policy.
