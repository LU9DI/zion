# Zion — Current engineering audit

Date: 2026-10-10  
Repository: https://github.com/LU9DI/zion  
Audited revision at start: `d79e60fe38a59b8a7b8cfc2460cd4abe571fb6ac`; documentation updates follow this report.

## Verdict

**Not production-ready.** The source archive is now in GitHub and the full AGPL-3.0-only license text has been committed. The codebase contains useful local primitives and tests, but does not yet constitute a working public decentralized cloud. Historical test counts are not a substitute for a fresh green CI run on the current tree.

## Issues fixed in this pass

- Replaced the stale README heading/version and misleading opening status with the package version and a concise prototype/production boundary.
- Added this current audit so the principal blockers are discoverable without reading every historical audit.
- The restoration workflow is being restricted to explicit manual invocation, to prevent a later edit to the workflow file from automatically re-copying an old archive over the repository.
- The validation workflow is being made active instead of carrying a “dormant” condition after source restoration.

## Remaining blockers (ordered by risk)

### P0 — Do not expose to the public internet

1. **No deployed P2P network.** `src/dht-provider-discovery.js` is an injected adapter boundary. There is no configured live libp2p/Kademlia DHT, bootstrap diversity, NAT traversal, or validated peer-to-peer connectivity.
2. **Experimental TCP transport is not encrypted.** `src/peer-transport.js` uses signed messages and bounded framing but does not provide TLS or equivalent channel confidentiality. Do not expose it directly to the public internet or send secrets over it.
3. **Production key lifecycle is incomplete.** File-key sharing/recovery, identity lifecycle, key rotation/revocation, and secure recovery flows are not a complete integrated user-facing system. Keep content keys out of manifests and do not treat node identity as authorization.
4. **OS resource enforcement is incomplete.** `ResourceGovernor` computes budgets; it does not itself enforce CPU, memory, disk, bandwidth, thermal, or user-activity limits. The Linux cgroup adapter explicitly reports `complete: false`; it must not be used to authorize production contribution. Disk quota accounting in the Rust prototype is not a kernel-enforced volume quota.
5. **Witness trust depends on integration.** Recovery requires the caller to implement `isSessionValid` and provide trusted publisher keys. The local replay ledger is not automatically a remote, rollback-resistant authority. A signed `fsynced` flag is an assertion by the publisher, not independent proof of physical durability.
6. **Distributed abuse resistance is incomplete.** Local token buckets, PoW primitives, allowlists, and bounded queues are building blocks only. They do not prevent distributed Sybil/eclipse attacks, cross-peer DDoS, malicious bootstrap concentration, or repair storms.

### P1 — Durability and data correctness

7. **No production storage/replication integration.** The default memory adapter is test/demo-only; the Rust storage sidecar is opt-in and not wired into the active replica path. Production needs a durable authenticated adapter, recovery tests across process restarts, and cross-platform filesystem verification.
8. **Replication acknowledgements are not proof of durable storage.** Receipts bind acknowledgements to identities and content but cannot prove a malicious peer actually persisted the bytes. Integrate real remote storage handlers and verify read-back from independent peers.
9. **Erasure coding, retention, garbage collection and secure deletion are absent or incomplete.** These affect availability, cost, and privacy and must be designed before promising durable cloud storage.
10. **Filesystem guarantees vary.** Hard-link no-replace commits, directory fsync, lock semantics and quota accounting need platform-specific testing. Network filesystems and malicious same-user processes are outside the guarantees of several local-file locks.

### P1 — CI and release integrity

11. **CI failure was a workflow-gating issue, now fixed.** The old job-level `hashFiles(...)` gate left the validation workflow with no jobs; the failed run did not demonstrate a code/test failure. After removing that gate, GitHub Actions passed on commits `8551fee078af62d374620ebedfb02b097e1dd865` and `cd135ce4cba926b22160549103c5dbd44a156813`: syntax checks, all 533 Node tests, and both demos passed. [Latest passing run](https://github.com/LU9DI/zion/actions/runs/38062968893). This does not certify production security.
12. **Dependency reproducibility is limited.** There is no `package-lock.json`; npm currently has no declared JS runtime dependencies, but future dependencies must be locked. Rust has a Cargo dependency but no committed `Cargo.lock` was found in the repository tree.
13. **Supply-chain/release verification is incomplete.** Checksums establish integrity of the bytes hashed, not trusted provenance. Add release signing, dependency/security scanning, reproducible builds where feasible, and independent verification of published artifacts.
14. **Archive and source can diverge.** The preserved ZIP is committed alongside the expanded source. A manifest/check step should compare the archive's intended source snapshot to the repository without automatically overwriting newer work.

### P2 — Product readiness and maintainability

15. **Cloud UI is a preview.** File selection is local metadata only; there are no real accounts, uploads, persisted file data, synced profiles, or network-delivered messages.
16. **README history is very long and repetitive.** This pass corrects the top-level status; release history should eventually move into CHANGELOG/audit documents.
17. **Test depth still needs adversarial testing.** Add fuzzing/property tests for protocol parsers, malformed signed metadata, path/symlink races, crash injection across commit windows, multi-process contention, hostile peers, and resource exhaustion.
18. **Independent security review is outstanding.** No local test suite proves production safety; do not store sensitive data or the sole copy of important files.

## Verification and safe operating envelope

Run on a clean checkout with Node.js 20+:

```sh
npm run check
npm test
npm run demo
npm run client:demo
cargo test --manifest-path rust-core/Cargo.toml
```

The Rust test requires Cargo and first-time access to the `sha2` crate. A failure to download the dependency is an environment/network failure, not a passing test. The current GitHub Actions workflow validates Node.js only; the Rust crate has not yet been verified by that CI workflow.

Until P0 blockers are closed and independently reviewed, use Zion only for local experiments on non-sensitive data. Do not advertise it as a public cloud, a Tor replacement, or a production-safe decentralized network.
