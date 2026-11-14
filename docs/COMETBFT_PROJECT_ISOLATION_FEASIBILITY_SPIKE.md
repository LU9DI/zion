# CometBFT project-isolation feasibility spike

Status: **test specification only; no CometBFT dependency, sidecar, ABCI application, or runtime code has been added**  
Scope: PR #68. This spike determines whether CometBFT can satisfy Zion's project-scoped consensus and decentralization constraints without turning Zion into a global chain or adding disproportionate runtime complexity.

## 1. Decision question

Can a CometBFT-based design provide independent, project-scoped committed state for at least two unrelated Zion projects, with independent validator committees, independent failure domains, and no central service, while preserving the product invariant that Zion does not require a global blockchain?

A successful single-project ABCI demo is not sufficient. The proof must demonstrate cross-project isolation and quantify the cost of operating many project state machines.

## 2. Hard constraints

The spike must preserve all of the following:

- No mandatory Zion-hosted coordinator, database, CA, registry, cloud bucket, or bootstrap server.
- No global Zion chain or global validator committee.
- No native token, mining, staking requirement, or unapproved economic mechanism.
- Project A must not be able to read, mutate, pause, or change the validator set of project B.
- A Byzantine or unavailable quorum in project A must not halt project B.
- Each project's governance epoch, validator epoch, operation IDs, committed sequence, and state digest remain project-scoped.
- No local or hosted fallback may commit critical mutations without the project's required quorum.
- The PoC must use test-only keys and data; no production keys, current user data, official launcher, Neon, or existing migrations.
- The PoC must be disposable and isolated from production runtime paths. No merge, release, or deployment is part of this spike.

## 3. Topologies to compare

The spike must implement or rigorously rule out these topologies before selecting one:

### A. One CometBFT chain/process per project

Each project has its own CometBFT chain identity, validator set, ABCI application state, persistent consensus state/WAL, and process lifecycle.

**Potential advantage:** natural fault and validator-set separation if every project is truly independent.

**Required proof:** no shared mutable consensus state; project A partition/restart/reconfiguration does not affect B; no central supervisor required for correctness; resource use and operational burden remain acceptable as project count grows.

**Primary risk:** one process and consensus network per project may be too expensive for a peer node participating in many projects. It may also impose block/chain semantics that conflict with Zion's no-blockchain product invariant. This must be decided explicitly, not hidden behind terminology.

### B. One shared CometBFT chain with project namespaces

A single chain orders all projects' operations, with projectId namespacing application state.

**Potential advantage:** fewer consensus processes and a single application boundary.

**Disqualifying risks:** global ordering/validator set, shared liveness and resource contention, cross-project censorship/DoS coupling, and a global consensus dependency. This topology is presumed incompatible with the current architecture; it may be tested only as a negative control, not silently adopted.

### C. One CometBFT process per node with multiplexed project committees

One local process attempts to manage multiple independent project committees and state machines.

**Required proof:** the exact upstream API and implementation must support independent consensus instances, chain identities, validator sets, WALs, and recovery boundaries without hidden shared safety state. If the design actually multiplexes one global validator set or one global height/commit stream, it fails the project-isolation requirement.

Do not assume ABCI multiplexing is equivalent to independent consensus instances.

### D. Multiple in-process or sidecar consensus instances

A node runs multiple independently configured consensus instances under a shared local supervisor or a Go sidecar.

**Required proof:** crash, resource exhaustion, supervisor failure, upgrade, and process restart of one instance cannot corrupt or pause another; every instance can recover independently from its own durable state. The supervisor must not be a trusted ordering authority or a central network dependency.

This topology still has to meet the product's complexity and resource limits. A sidecar is an implementation boundary, not decentralization by itself.

## 4. Minimum test topology

Use two projects, project-alpha and project-beta, with disjoint test validator keys and disjoint state namespaces.

For any topology claiming independent BFT committees, use at least four validator identities per project for the f=1 / 3f+1 test configuration. This is a test configuration, not a product default or a claim of independent real-world operators. The test harness must explicitly model key control domains and include cases where multiple keys belong to one adversarial operator.

Each project begins from a different genesis manifest and state digest. The initial committees, governance epochs, and protocol versions are independent. No global test key, shared voting power, or implicit cross-project admin role is permitted.

The test harness must record per project:
- chain/instance identity and pinned CometBFT version;
- genesis manifest digest;
- committee epoch and exact public-key set/weights;
- height/sequence, parent digest, app hash, and commit certificate;
- WAL and application-state storage location;
- process ID and resource use;
- transaction admission/commit outcome and latency;
- restart/recovery point and validator-update activation height.

## 5. Required experiment matrix

### 5.1 Functional isolation

1. Commit independent operations in A and B and verify separate histories/state roots.
2. Replay an A operation against B and vice versa; both must reject it.
3. Attempt project-ID substitution, wrong genesis digest, wrong committee epoch, stale state digest, and replayed operation IDs.
4. Attempt to submit a validator update for A through B's application context; reject deterministically.
5. Verify that no transaction or event in one project changes the other's app hash, sequence, committee, or authorization state.

### 5.2 Failure isolation

1. Stop all B validators while A continues; A must continue committing if its own quorum is available.
2. Partition B below quorum; B critical writes must stop, while A continues.
3. Crash/restart one A consensus process during proposal, vote, and commit; B must be unaffected.
4. Corrupt or truncate A's test WAL/application state; A must fail closed or recover according to documented upstream guarantees, while B continues.
5. Exhaust A's configured CPU, memory, disk, and message budgets; B must retain its declared resource isolation.
6. Kill the local supervisor/sidecar (if present); document whether all projects fail together. If a single supervisor failure halts all projects, quantify and justify this correlated failure domain; it must not be concealed as project independence.

### 5.3 Reconfiguration

1. Submit a valid validator-set update in A and verify exact upstream activation timing, including H+1 next-validator hash, H+2 active validator set, and H+3 last-commit metadata.
2. Keep B unchanged and verify its committee digest, height, and app hash are unchanged by A's reconfiguration.
3. Exercise duplicate validator keys, zero-power removals, negative power, excessive total voting power, stale committee epochs, and unauthorized updates.
4. Partition old/new A committees around the activation boundary; verify no conflicting commit history and no unsafe local fallback.
5. Crash during validator update and restart at each relevant height; verify WAL and app state agree on the same committee epoch.
6. Verify the application emits deterministic validator updates from committed input/state only.

### 5.4 Adversarial and recovery behavior

1. Byzantine validator equivocation, double-voting attempts, stale votes, and replayed certificates.
2. A validator key controlled by the same adversarial operator as multiple other keys; do not count keys as independent operators.
3. Delayed messages, packet loss, network partitions, and clock skew within/outside configured assumptions.
4. Disk full, fsync failure, partial writes, abrupt power loss simulation, and restart.
5. Upgrade one project instance while another remains on its prior compatible version; verify explicit version negotiation and no silent state divergence.
6. Restore A from its own backup/snapshot without reading B's data or a hosted service; verify cryptographic continuity against A's trusted checkpoint.
7. Attempt to restore B from A's snapshot or vice versa; reject.

### 5.5 Scale and complexity

Measure one, two, ten, and one hundred project instances (or the maximum feasible number, with the limit clearly stated):
- idle and active memory per project;
- CPU and disk I/O per project;
- file descriptors, sockets, goroutines/threads, WAL growth, and compaction cost;
- startup and recovery time;
- validator-set reconfiguration cost;
- number of required processes and persistent directories;
- operational burden for a node joining/leaving many projects.

Report p50/p95/p99 operation latency under load and under one project's resource-exhaustion attack. No arbitrary performance threshold should be invented after results; define acceptable limits before running the experiment.

## 6. Determinism and storage boundary

The ABCI application must be a deterministic state machine. All replicas must compute the same result from the same committed input and prior committed state. Wall-clock reads, randomness, local filesystem enumeration, environment-dependent values, network lookups, and non-deterministic iteration must not influence committed state transitions.

The application must not mutate consensus-critical state through a side channel outside the consensus execution boundary. If a local storage adapter is needed, define crash consistency, atomicity, fsync, backup, restore, and schema-upgrade semantics. Do not use a shared PostgreSQL/Neon database as the hidden source of truth for the PoC.

The committed application state should be content-addressed or otherwise verifiable from the consensus app hash. Each project must have its own state root and independently verifiable checkpoint.

## 7. Acceptance criteria

The CometBFT path is **feasible for further evaluation only if** all are demonstrated:

- Two projects have distinct, independently verifiable committed histories and validator committees.
- A project's partition, quorum loss, crash, reconfiguration, or resource exhaustion cannot halt or mutate another project's committed state.
- No global chain, global committee, central coordinator, mandatory hosted service, or shared database is required.
- The selected topology has an explicit, bounded resource model for a node participating in many projects.
- Validator updates, WAL recovery, deterministic execution, and snapshot verification pass the full test matrix.
- The implementation pins an exact upstream release/commit, license, dependency closure, build reproducibility, and platform support.
- The sidecar/process boundary does not create a privileged consensus authority or unacceptable common failure domain.
- The design is compatible with the no-token/no-mining/no-central-identity constraints and the Sybil/governance assumptions already recorded.
- Independent security review can inspect the exact integration and reproduce the test results.

A failure of any isolation, safety, or decentralization criterion is a no-go, not a warning to be worked around by adding a central coordinator.

## 8. Explicit no-go conditions

Reject CometBFT for Zion if:
- independent project committees require a global validator set or global commit stream;
- one project's consensus or storage exhaustion can stop another project's critical writes;
- the only practical topology requires an unbounded number of heavyweight consensus processes per peer;
- a central supervisor or hosted service becomes necessary for correctness, recovery, or validator membership;
- safe committee reconfiguration or durable vote recovery cannot be demonstrated;
- adopting it forces a global chain or other product-level constraint Zion has explicitly rejected;
- the integration requires a bespoke fork or extensive protocol modifications that Zion cannot maintain and independently review.

If no CometBFT topology passes, keep it as a reference candidate and evaluate a smaller, maintained project-scoped state replication design only if it has a formal safety argument and reviewed implementation. Do not respond by writing a new BFT protocol from scratch.

## 9. Evidence record required for a completed spike

The eventual report must include:
- exact upstream repository, release tag, commit SHA, license, and dependency tree;
- topology and process diagram;
- exact commands and environment;
- test source and immutable result artifacts;
- all failures, crashes, timeouts, and retries;
- measured resource/latency tables;
- state/committee digests before and after each scenario;
- proof that projects A and B remained isolated;
- limitations and unresolved risks;
- independent reviewer and review scope, if any.

A narrative-only report or a passing happy-path demo is not proof of feasibility.

## 10. Current status and non-claims

- This file is a test specification, not an executed PoC.
- No CometBFT version or topology is selected.
- No code, dependency, launcher, database, migration, or production runtime is changed.
- No project isolation, BFT safety/liveness, validator reconfiguration, or crash recovery is proven for Zion.
- PostgreSQL/Neon remain transitional and untouched; PR #63/#64 and their bases remain untouched.


## 11. Pinned upstream source baseline (evaluation only)

The source inspection for this spike uses the following immutable upstream baseline:

- Repository: `https://github.com/cometbft/cometbft`
- Release tag: `v0.40.0`
- Annotated tag object: `06b4cbf4b776554bd2b95fc39c80991e7529e765`
- Tag target commit: `0880b4d378f347ab16e54ec677ff50d803f37d62`
- Tag signature: GitHub API reports the annotated tag signature as verified.
- License: Apache-2.0 (the release's `LICENSE` file).
- Go module directive: `go 1.25.0` (from `go.mod` at the exact release tag).
- Release publication: 2026-07-27.

This is a reproducible **spike input pin only**. It does not select CometBFT for Zion, approve a dependency, or establish production suitability. Re-evaluate supported/security status and the exact dependency closure before any future adoption.

### 11.1 Source-level isolation observations

Inspection of the exact `v0.40.0` source shows that `node.Node` owns singular per-node fields for its config, genesis document, state store, block store, consensus state/reactor, proxy application connections, and related services. `node/setup.go` constructs the application proxy, block executor, mempool, evidence pool, state-sync reactor, and consensus reactor from one node configuration and one genesis/state context.

Consequences:

- A single ordinary `Node` instance is a single-chain/single-application execution context; it is not a built-in multi-project committee manager.
- Project namespaces inside one ordinary chain would still share that chain's consensus history and validator set, and remain a negative control rather than an acceptable Zion design.
- Running multiple `Node` instances in one Go process may be technically investigable, but the inspected API shape alone does not prove safe isolation of package-level state, metrics registries, listeners, storage, WALs, lifecycle, or crash recovery.
- Separate processes with separate configs, genesis documents, validator keys, databases/directories, ports, and ABCI applications remain the most straightforward topology to test first. That topology may still fail Zion's resource/complexity constraints and is not approved.

### 11.2 Reproducible source inspection and build preparation

The disposable experiment must fetch the exact tag and verify the peeled commit before building:

```sh
git clone https://github.com/cometbft/cometbft.git cometbft-spike
cd cometbft-spike
git fetch --tags --force
git checkout --detach v0.40.0
git rev-parse HEAD
# Expected: 0880b4d378f347ab16e54ec677ff50d803f37d62
go version
# Must satisfy the go.mod directive: Go 1.25.0 or compatible newer toolchain.
go mod download
go mod verify
```

Before treating a build as reproducible, record the exact Go toolchain build, OS/architecture, module download checks, dependency graph/SBOM, and hashes of the resulting binaries. A successful local build is not a substitute for the two-project failure/isolation matrix.

### 11.3 Current conclusion

- `v0.40.0` is pinned as the upstream test baseline only.
- No Go toolchain, CometBFT source checkout, binary, container image, or PoC was built or run in this session.
- No claim is made that multiple in-process nodes are isolated or supported.
- No topology is selected; one-process-per-project is only the first topology to evaluate, subject to resource and product-constraint gates.
- The Apache-2.0 license permits use subject to its terms; the full dependency tree still requires its own license/security review.
