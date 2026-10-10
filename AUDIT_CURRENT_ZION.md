# Zion — Current engineering audit

Date: 2026-10-10  
Repository: https://github.com/LU9DI/zion  
Audited revision at start: `d79e60fe38a59b8a7b8cfc2460cd4abe571fb6ac`; documentation updates follow this report.

## Verdict

**Not production-ready.** The source archive is now in GitHub and the full AGPL-3.0-only license text has been committed. The codebase contains useful local primitives and tests, but does not yet constitute a working public decentralized cloud. GitHub Actions now passes on the current source and audit tree; passing tests are not a security certification.

## Issues fixed in this pass

- Replaced the stale README heading/version and misleading opening status with the package version and a concise prototype/production boundary.
- Added this current audit so the principal blockers are discoverable without reading every historical audit.
- Restricted the restoration workflow to explicit manual invocation plus a confirmation phrase, preventing ordinary workflow edits from automatically re-copying an old archive over the repository.
- Activated CI for every push/PR, extended syntax checks to `.js`, `.mjs`, and `.cjs`, added a root Cargo workspace and Rust tests, and fixed the Rust quota test fixture exposed by CI.
- Changed peer transport so non-loopback listeners and outbound connections fail closed unless mutual TLS material is configured; outbound TLS now waits for `secureConnect` before attaching the protocol parser, and the server closes incomplete TLS handshakes after a configurable bounded timeout. Added regression tests for fail-closed policy, malformed loopback addresses, and real mutual-TLS handshakes with ephemeral test certificates.
- Fixed a resource-governor edge case where an explicit zero CPU, memory, disk, or concurrency limit could still report contribution as enabled. Decisions now include a bounded disk budget and preserve fractional CPU budgets; regression tests cover zero-limit opt-outs.
- Added weekly Dependabot monitoring for npm, Cargo, and GitHub Actions, plus scheduled CodeQL analysis for JavaScript/TypeScript and Rust. These scanners complement but do not replace review and runtime tests.

## Remaining blockers (ordered by risk)

### P0 — Do not expose to the public internet

1. **No deployed P2P network.** `src/dht-provider-discovery.js` is an injected adapter boundary. There is no configured live libp2p/Kademlia DHT, bootstrap diversity, NAT traversal, or validated peer-to-peer connectivity.
2. **Transport confidentiality improved, but deployment is still incomplete.** `src/peer-transport.js` now rejects non-loopback listeners and outbound connections unless mutual TLS key/certificate/CA material is configured; plaintext is restricted to loopback. CI tests the fail-closed policy and now creates ephemeral real certificates to exercise a mutual-TLS handshake, signed message exchange, and rejection of an untrusted CA. This is local interoperability coverage only; there is still no production certificate issuance/rotation/trust-distribution system, revocation strategy, or independent deployment test. Do not expose a node until those operational pieces are configured and independently tested.
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

11. **CI issues found and fixed.** The old job-level `hashFiles(...)` gate left the validation workflow with no jobs. After removing it, validation uncovered a bad quota fixture in the Rust test; the fixture incorrectly configured storage below the maximum chunk size. The test was corrected and the Rust workspace was declared at the repository root. The current validation run passed: 168 `.js/.mjs/.cjs` files syntax-checked, 533 Node tests passed, both demos passed, and all 3 Rust unit tests passed. [Passing run](https://github.com/LU9DI/zion/actions/runs/38063144217). This does not certify production security.
12. **Dependency reproducibility is partial.** A root `package-lock.json` is committed and CI uses `npm ci`; it currently records the project with no third-party npm dependencies. A committed `Cargo.lock` is still absent, so Rust dependency resolution is not fully pinned.
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

The Rust test requires Cargo and first-time access to the `sha2` crate. CI runs the Rust tests. Rust dependency resolution remains unpinned until a generated `Cargo.lock` is committed.

Until P0 blockers are closed and independently reviewed, use Zion only for local experiments on non-sensitive data. Do not advertise it as a public cloud, a Tor replacement, or a production-safe decentralized network.
