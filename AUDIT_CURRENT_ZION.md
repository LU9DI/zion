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
- Changed peer transport so non-loopback listeners and outbound connections fail closed unless mutual TLS material is configured; plaintext loopback is restricted to validated IP literals, not resolver-dependent `localhost` aliases. Outbound TLS waits for `secureConnect` before attaching the protocol parser; both inbound and outbound TLS handshakes have bounded timeouts. Regression tests cover fail-closed policy, malformed IPs, localhost bind alias rejection, real mutual-TLS handshakes with ephemeral test certificates, and an unresponsive TLS peer.
- Fixed resource-governor edge cases where explicit zero CPU, memory, disk, or concurrency limits—or a memory/disk budget rounded to zero under host pressure—could still report contribution as enabled. Decisions include a disk budget and preserve fractional CPU budgets; regression tests cover zero-limit opt-outs.
- Hardened Rust chunk reads: Unix opens use `O_NOFOLLOW|O_CLOEXEC`, root and shard paths are checked against symlinks, file size is checked from the opened handle, actual reads are bounded to the configured chunk ceiling, and regression tests reject symlinked chunk and shard targets. Existing-chunk detection now uses typed filesystem errors rather than matching platform-specific error-message text. `libc` is pinned and recorded in `Cargo.lock`.
- Added weekly Dependabot monitoring for npm, Cargo, and GitHub Actions, plus scheduled CodeQL analysis for JavaScript/TypeScript and Rust. These scanners complement but do not replace review and runtime tests.
- Hardened the Rust sidecar adapter's stderr handling: output above 4 KiB now terminates the child with a typed `SIDECAR_OUTPUT_LIMIT` error, and output handlers stop buffering after an operation settles. Added a regression test for oversized stderr.
- Bounded the Rust storage core's accepted chunk size to 64 MiB, matching the Node adapter, and made quota scans reject unexpected hidden root entries instead of silently skipping them. Added Rust regression tests for both cases.
- Persisted the Rust sidecar's local quota configuration atomically on initialization and first write; later runs with a mismatched chunk/storage quota now fail closed instead of silently changing policy. This remains an application-level quota, not an OS-enforced disk quota.
- Extended the real Node-to-Rust integration test to create a fresh adapter against the same root, read the previously committed ciphertext back, and re-check quota exhaustion after reinitialization.
- Added a filesystem-store regression test that reopens the replica store, verifies previously stored ciphertext remains readable, and confirms the persisted quota remains enforced after reinitialization. This covers the Node filesystem store only; it does not claim the Rust sidecar's restart behavior is fully validated.

## Remaining blockers (ordered by risk)

### P0 — Do not expose to the public internet

1. **No deployed P2P network.** `src/dht-provider-discovery.js` is an injected adapter boundary. There is no configured live libp2p/Kademlia DHT, bootstrap diversity, NAT traversal, or validated peer-to-peer connectivity.
2. **Transport confidentiality improved, but deployment is still incomplete.** `src/peer-transport.js` now rejects non-loopback listeners and outbound connections unless mutual TLS key/certificate/CA material is configured; plaintext is restricted to loopback. CI tests the fail-closed policy and now creates ephemeral real certificates to exercise a mutual-TLS handshake, signed message exchange, and rejection of an untrusted CA. This is local interoperability coverage only; there is still no production certificate issuance/rotation/trust-distribution system, revocation strategy, or independent deployment test. Do not expose a node until those operational pieces are configured and independently tested.
3. **Production key lifecycle is incomplete.** File-key sharing/recovery, identity lifecycle, key rotation/revocation, and secure recovery flows are not a complete integrated user-facing system. Keep content keys out of manifests and do not treat node identity as authorization.
4. **OS resource enforcement is incomplete.** `ResourceGovernor` computes budgets; it does not itself enforce CPU, memory, disk, bandwidth, thermal, or user-activity limits. The Linux cgroup adapter explicitly reports `complete: false`; it must not be used to authorize production contribution. Disk quota accounting in the Rust prototype is not a kernel-enforced volume quota.
5. **Witness trust depends on integration.** Recovery requires the caller to implement `isSessionValid` and provide trusted publisher keys. The local replay ledger is not automatically a remote, rollback-resistant authority. A signed `fsynced` flag is an assertion by the publisher, not independent proof of physical durability.
6. **Distributed abuse resistance is incomplete.** Local token buckets, PoW primitives, allowlists, and bounded queues are building blocks only. They do not prevent distributed Sybil/eclipse attacks, cross-peer DDoS, malicious bootstrap concentration, or repair storms.

### P1 — Durability and data correctness

7. **No production storage/replication integration.** The default memory adapter is test/demo-only; the Rust storage sidecar is opt-in and not wired into the active replica path. CI now builds the actual Rust CLI and exercises a real Node.js `PeerStorageService` upload through `RustStorageAdapter`, including read-back, usage accounting, and quota exhaustion. The adapter also bounds process runtime/output and rejects put receipts whose byte count disagrees with the submitted envelope. These are local integration checks, not bootstrap or production lifecycle integration. The Rust store syncs file data before publishing the content-addressed name and now syncs the containing directory on Unix. Chunk reads reject symlink targets at open time on Unix and bound bytes read; this does not remove all path races for hostile local writers or provide cross-platform filesystem guarantees. Production still needs bootstrap/lifecycle integration, recovery tests across process restarts, and cross-platform filesystem verification.
8. **Replication acknowledgements are not proof of durable storage.** Receipts bind acknowledgements to identities and content but cannot prove a malicious peer actually persisted the bytes. Integrate real remote storage handlers and verify read-back from independent peers.
9. **Erasure coding, retention, garbage collection and secure deletion are absent or incomplete.** These affect availability, cost, and privacy and must be designed before promising durable cloud storage.
10. **Filesystem guarantees vary.** Hard-link no-replace commits, directory fsync, lock semantics and quota accounting need platform-specific testing. Network filesystems and malicious same-user processes are outside the guarantees of several local-file locks.

### P1 — CI and release integrity

11. **CI issues found and fixed.** The old job-level `hashFiles(...)` gate left the validation workflow with no jobs. After removing it, validation uncovered a bad quota fixture in the Rust test; the fixture incorrectly configured storage below the maximum chunk size. The test was corrected and the Rust workspace was declared at the repository root. The latest validation run passed: syntax checks, 545 passing Node tests (546 total including one skipped optional integration test), both demos, all 3 Rust unit tests, a release build of the Rust sidecar, and the real Node-to-Rust storage interoperability test. [Passing run](https://github.com/LU9DI/zion/actions/runs/38071197824). This does not certify production security.
12. **Dependency reproducibility is now pinned for the current workspace.** The root `package-lock.json` and `Cargo.lock` are committed; CI uses `npm ci` and `cargo test --locked`. The Rust `sha2` dependency is pinned to `=0.10.9`. Dependency updates still require review and lockfile regeneration.
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

The Rust test requires Cargo and registry access on a fresh runner. CI now uses the committed `Cargo.lock` with `cargo test --locked`; the lockfile was generated by Cargo in GitHub Actions and committed after validation.

Until P0 blockers are closed and independently reviewed, use Zion only for local experiments on non-sensitive data. Do not advertise it as a public cloud, a Tor replacement, or a production-safe decentralized network.
