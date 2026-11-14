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

The first reproducible spike should use the latest patch release on the upstream README's explicitly listed supported line, rather than assuming the newest version tag is already the supported baseline:

- Repository: `https://github.com/cometbft/cometbft`
- Primary evaluation release: `v0.38.26` (published 2026-08-13; not a production selection).
- Annotated tag object: `2228c7101a00994a14811e15cd8795c7e70713c2`
- Tag target commit: `94d77f9f51a72e2b7d832798859f6222f08028f8`
- Tag signature: upstream GitHub API reports the annotated tag signature as verified.
- License: Apache-2.0 (release `LICENSE`).
- Go module directive: `go 1.22.11` (from `go.mod` at the exact release tag).

Version-selection caveat:

- The newer tag `v0.40.0` was also inspected; its exact target commit is `0880b4d378f347ab16e54ec677ff50d803f37d62`, its tag signature is reported verified, and its `go.mod` declares `go 1.25.0`.
- However, the `v0.40.0` README's `Supported Versions` section lists `v0.38.x`, not `v0.40.x`. Therefore `v0.40.0` is recorded as a newer exploratory comparison only; do not treat it as the supported baseline or production recommendation without upstream clarification.
- The `v0.38.26` pin is a reproducible test input only. Re-evaluate upstream support/security status and the exact dependency closure before any future adoption.

### 11.1 Source-level isolation observations

Inspection of the exact `v0.38.26` source shows that `node.Node` owns singular per-node fields for its config, genesis document, state store, block store, consensus state/reactor, proxy application connections, and related services. `node/setup.go` constructs the application proxy and consensus services from one node configuration and one genesis/state context.

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
git checkout --detach v0.38.26
git rev-parse HEAD
# Expected: 94d77f9f51a72e2b7d832798859f6222f08028f8
go version
# Must satisfy the go.mod directive: Go 1.22.11 or compatible newer toolchain.
go mod download
go mod verify
```

Before treating a build as reproducible, record the exact Go toolchain build, OS/architecture, module download checks, dependency graph/SBOM, and hashes of the resulting binaries. A successful local build is not a substitute for the two-project failure/isolation matrix.

### 11.3 Current conclusion

- `v0.38.26` is pinned as the primary upstream test baseline only; `v0.40.0` is a comparison candidate only.
- No Go toolchain, CometBFT source checkout, binary, container image, or PoC was built or run in this session.
- No claim is made that multiple in-process nodes are isolated or supported.
- No topology is selected; one-process-per-project is only the first topology to evaluate, subject to resource and product-constraint gates.
- The Apache-2.0 license permits use subject to its terms; the full dependency tree still requires its own license/security review.


## 12. Execution-environment attempt (2026-11-13)

This section records an attempted preparation of the disposable PoC in the available execution environment. It is an environment report, not a CometBFT test result.

Observed environment:
- Go toolchain: `go version go1.23.2 linux/amd64`. This satisfies the release's declared Go `1.22.11` minimum.
- Git: `2.47.3`.
- Docker: unavailable (`docker: command not found`).
- Direct outbound access to `github.com`: unavailable in this environment. Both `git ls-remote https://github.com/cometbft/cometbft.git refs/tags/v0.38.26` and an HTTPS request failed because DNS could not resolve `github.com`.
- The GitHub repository connector could retrieve individual UTF-8 source files for inspection, including the exact-tag `go.mod`, `LICENSE`, `node/node.go`, and `node/setup.go`; it cannot provide a runnable checkout or execute Go builds/tests.

Source observations confirmed from the exact `v0.38.26` tag:
- `go.mod` declares `go 1.22.11`.
- `LICENSE` is Apache License 2.0.
- `node.Node` contains singular per-node configuration, genesis, state store, block store, consensus state/reactor, proxy application connections, and service fields.
- `DefaultNewNode` constructs a node from one config, one local node key, one private validator, one application client, one genesis provider, one DB provider, and one metrics provider. This reinforces that the ordinary Node abstraction is not a built-in multi-project committee manager; it does not prove that multiple Node objects in one process are safely isolated.

Execution outcome:
- Source inspection: **partial, completed through read-only GitHub source access**.
- Source checkout: **blocked**.
- Dependency download / checksum verification: **not run**.
- Build / unit tests / e2e tests: **not run**.
- Two-project, eight-validator PoC: **not run**.
- No runtime code or dependencies were added to Zion.

The next valid execution environment must provide a full disposable checkout, outbound access to the pinned Go module sources (or a verified offline module cache), and enough process/network isolation to run eight validator processes. Docker is convenient but not intrinsically mandatory if the harness uses separate native processes, isolated data directories, and distinct P2P/RPC/ABCI ports. Before the PoC begins, the harness must also define CPU, memory, disk, file-descriptor and port budgets; do not infer acceptable scale after seeing the results.

This blocker must not be bypassed by copying a partial subset of upstream source files, silently changing the pinned release, weakening the two-project matrix, or treating source inspection as a successful build/test.


## 13. Additional in-process isolation blocker found by source inspection

A follow-up read-only inspection identified a **conditional** obstacle to running multiple ordinary CometBFT `Node` objects in one process with Prometheus instrumentation enabled:

- CometBFT `v0.38.26/node/setup.go` selects the Prometheus metrics provider when `config.Prometheus` is true.
- The CometBFT metrics Prometheus adapter uses constructors such as `NewGaugeFrom`, `NewCounterFrom`, and `NewHistogramFrom`. The inspected `go-kit/kit v0.13.0` adapter implementation registers collectors with `prometheus.MustRegister`, which targets the package's default global registry.
- CometBFT exposes the default Prometheus registerer/gatherer in its standard metrics-serving path.
- Therefore, two nodes in one process that both use the unmodified default provider and register identical metric descriptors may collide (including a panic from `MustRegister`). A chain-ID label alone does not create a separate registry.

**Important qualification:** CometBFT's instrumentation configuration defaults Prometheus to `false`. This is not an unconditional startup blocker and must not be described as a collision under the default disabled-metrics configuration. The risk applies when Prometheus is enabled and the standard global-registry path is used. See the upstream metrics documentation and configuration defaults.

This is a source-derived integration risk, not a reproduced runtime failure in this session. The in-process topology must explicitly test:
1. two `Node` objects with Prometheus enabled and the unmodified default provider, recording whether collector registration collides;
2. two nodes with metrics disabled, to determine whether other shared package-level state remains;
3. a custom per-instance metrics provider/registry design, only if the upstream API permits it without a fork, including independent HTTP exposition and shutdown;
4. concurrent start/stop/restart and registry cleanup, ensuring one node cannot unregister, mutate, or hide another node's metrics.

Disabling metrics or changing instrumentation removes at most this identified conditional obstacle; it does not establish safe isolation of consensus, WAL, databases, listeners, package-level state, goroutines, or crash recovery. The separate-process topology remains the first PoC target.


## 14. Upstream E2E harness and execution-path constraint

The upstream CometBFT E2E documentation describes a staged runner that generates configuration, starts Docker containers, applies load and perturbations, waits for network convergence, runs Go E2E tests, and then stops/cleans up the containers and networks.

Implications for this spike:

- The upstream E2E runner is the preferred starting point for reproducing CometBFT's own network-level behavior, but its documented start/stop/cleanup path requires Docker.
- The current execution environment has no Docker executable, so the upstream E2E runner cannot be used here as documented.
- CometBFT documents ways to run individual nodes outside that E2E runner. That is not equivalent to the full multi-node E2E harness and does not automatically provide controlled partitions, resource limits, or safe cleanup.
- A native-process replacement harness is possible in principle, but it must explicitly implement process supervision, unique per-node data roots, P2P/RPC/ABCI port allocation, peer topology, network fault injection, process-group cleanup, and resource accounting. It must not be described as the upstream E2E runner.
- Before writing that replacement, first attempt to obtain a Docker-capable disposable environment. If unavailable, document the exact missing isolation primitives and decide whether a native harness can safely reproduce each required scenario without weakening the acceptance matrix.

The upstream E2E runner's Docker dependency is an execution constraint, not evidence that CometBFT itself requires Docker at runtime. No PoC or E2E test was run as part of this documentation update.


## 15. Multiple-testnet runner: promising path, isolation still unverified

A follow-up review of the upstream E2E documentation found that CometBFT documents a `run-multiple.sh` helper for launching multiple testnets from separate TOML manifests. The same documentation describes generating testnet files into a custom directory and setting `E2E_TESTNET_DIR` when running tests against a custom testnet directory.

This is a materially better starting point than immediately writing a native process harness: it suggests the upstream test tooling already has a workflow for managing more than one testnet. It does **not** yet prove that two Zion project networks can safely run concurrently with independent failure domains.

### Evidence and version caveat

- Upstream E2E README documents: `./run-multiple.sh <manifest-glob>` for multiple testnets.
- The README also documents custom testnet output directories and `E2E_TESTNET_DIR`.
- The web-accessible README snapshot inspected for this finding is not yet tied in this audit to the exact pinned `v0.38.26` commit. Treat the feature as a promising upstream-documented capability, not yet as a verified property of the pinned release.
- The exact `run-multiple.sh` implementation at commit `94d77f9f51a72e2b7d832798859f6222f08028f8` has not yet been inspected. In particular, no claim is made about whether it serializes or parallelizes runs, how it handles failures, or whether all resource names are collision-free.

### Required source inspection before using it

At the pinned release, inspect `test/e2e/run-multiple.sh`, the runner's manifest loading and testnet-directory resolution, and the Docker Compose/network/container naming logic. Record exact answers to:

1. Does the helper start both testnets concurrently, sequentially, or by another policy?
2. Does each manifest resolve to a unique generated testnet directory without relying on a shared mutable output path?
3. Are Docker project names, container names, network names, volume names, and host ports unique across both manifests?
4. Does one failed start/stop/cleanup abort or tear down the other testnet?
5. Can each testnet be perturbed, stopped, restarted, and cleaned up independently?
6. Can the existing Go E2E test package target each manifest separately without cross-test global environment-variable races?
7. Are the two testnets configured with disjoint validator keys, genesis digests, P2P peer sets, RPC ports, and ABCI endpoints?

### Proposed use in the Zion PoC

If the pinned implementation passes the static review, use two explicit manifests (project-alpha and project-beta), each with four validators, disjoint keys, distinct genesis/state roots, and separate output directories. Start both, record their actual container/network/volume/port identities, then execute the functional and failure-isolation matrix from Sections 4–5.

The PoC must include cross-project negative checks and failure injection against only one testnet while continuously checking that the other continues committing. A successful `run-multiple.sh` invocation by itself is not an isolation test.

If the script or runner shares a global output path, colliding resource names, or coupled cleanup behavior, do not patch upstream tooling blindly. First determine whether the pinned runner offers documented per-testnet overrides; otherwise isolate two independent runner invocations with explicitly disjoint resource namespaces, or fall back to a carefully reviewed native-process harness.

### Status

- Multiple-testnet capability: **documented by upstream E2E README; exact pinned-tag verification pending**.
- `run-multiple.sh` source audit at the pinned commit: **not yet performed**.
- Two concurrent independent testnets: **not executed**.
- Docker isolation, port uniqueness, cleanup independence, and cross-project failure isolation: **not proven**.
- No code, dependency, launcher, database, migration, or production runtime was changed by this finding.


## 16. Pinned v0.38.26 E2E runner audit — sequential execution and global cleanup

The earlier Section 15 uncertainty has now been narrowed by read-only inspection of the exact pinned release sources at tag `v0.38.26` (peeled commit `94d77f9f51a72e2b7d832798859f6222f08028f8`). The upstream `run-multiple.sh`, `pkg/testnet.go`, `pkg/infrastructure.go`, `pkg/infra/docker/docker.go`, `runner/setup.go`, and `runner/cleanup.go` were fetched from the exact tag through read-only GitHub source access. No source was built or executed.

### 16.1 The helper is sequential, not concurrent

The pinned `run-multiple.sh` loops over manifest arguments and invokes `./build/runner -f "$MANIFEST"` inside that loop. The next manifest is not started until the previous runner invocation returns. On failure, it dumps that manifest's logs, invokes cleanup, records the failed manifest, and then continues to the remaining manifests.

**Conclusion:** this helper is useful for batch-running independent testnets one after another. It cannot demonstrate simultaneous project liveness or prove that a fault in A leaves B committing while both are running.

### 16.2 The default cleanup is global across all E2E testnets

The pinned `runner/cleanup.go` implements `cleanupDocker()` by listing and force-removing **all** Docker containers labelled `e2e`, then removing **all** Docker networks labelled `e2e`. The cleanup is not scoped to the `Testnet` argument or to a particular Compose project. `Cleanup(testnet)` subsequently removes only that testnet's local directory, but its Docker cleanup step is global.

The normal runner path invokes cleanup before setup, and the failure path in `run-multiple.sh` also invokes cleanup. Therefore, running two instances of this runner concurrently is unsafe: one runner's cleanup can terminate the other testnet's E2E-labelled containers and networks.

**This is a concrete harness-level cross-testnet failure coupling**, not a claim about CometBFT consensus itself.

### 16.3 Additional default resource collisions

The pinned source also reveals default values that make concurrent runs unsafe without explicit namespacing:

- `NewDockerInfrastructureData` allocates the same default IPv4 subnet (`10.186.73.0/24`) for every Docker testnet and initializes its host proxy-port generator at `5701` for each manifest.
- `NewTestnetFromManifest` derives the testnet name and output directory from the manifest filename. The generated Compose file uses node names as literal `container_name` values, rather than namespacing them by project/testnet.
- The generated Compose file publishes each node's proxy port from the generated `ProxyPort`; each separate testnet's default port generator begins at the same value. Reusing common node names and default settings therefore risks global container-name and host-port collisions.
- The Compose template mounts each node's data directory relative to that manifest's testnet directory. This is a useful per-manifest data separation, but it does not cancel the global cleanup, shared default subnet, or host-level naming/port collisions.

These are source-level observations. No concurrent Compose stacks were started, so no runtime collision was reproduced.

### 16.4 Decision for Zion

- Do **not** use the unmodified `run-multiple.sh` as the simultaneous two-project isolation harness.
- Sequential batch execution may still be useful for independent functional smoke tests, but it does not satisfy the cross-project failure-isolation acceptance criterion.
- Do **not** start concurrent instances of the unmodified runner: its global cleanup is sufficient to make that unsafe, even before considering subnet, container-name, and port collisions.
- Do not patch CometBFT's upstream test harness as part of Zion's production code. If a disposable test-only harness is considered, it must scope cleanup to exact resources owned by that testnet, give each stack a unique network/subnet, unique container names, unique host ports, and separate output directories, and test its own cleanup under concurrent execution.
- Any such wrapper must not use broad label-based deletion. It should record the exact resources it created and remove only those exact resources, with verification that another testnet's resources remain intact.
- The two-project PoC still needs eight validators and the full adversarial matrix. A modified test harness is not itself proof of consensus isolation.

### 16.5 Revised evidence status

- Exact `v0.38.26` README documents multiple-testnet batch execution: **verified**.
- Exact `v0.38.26` `run-multiple.sh` execution order: **verified sequential**.
- Exact `v0.38.26` cleanup scope: **verified global across E2E-labelled containers and networks**.
- Default subnet/port/container-name collision risks: **identified from source; not runtime-reproduced**.
- Concurrent two-project E2E run: **not executed**.
- Cross-project consensus, resource, and failure isolation: **not proven**.
- No CometBFT code was changed; no Zion runtime, dependency, launcher, database, migration, or production code was changed.


## 17. Runner command-path audit and safe orchestration options

A further read-only inspection of the pinned `v0.38.26` `test/e2e/runner/main.go` clarifies exactly where the global cleanup hazard occurs.

### 17.1 Which CLI paths invoke global cleanup?

- The root command's normal full-run `RunE` calls `Cleanup(cli.testnet)` before `Setup`, then starts, loads, perturbs, waits, tests, and (unless `--preserve`) cleans up again.
- The `benchmark` command also calls `Cleanup` before setup and after benchmarking.
- The individual `setup` command calls only `Setup`.
- The individual `start` command checks whether the testnet directory exists, calls `Setup` only if it does not, and then starts the nodes. It does not call `Cleanup`.
- The individual `stop` command calls the provider's Compose stop operation.
- The individual `cleanup` command calls `Cleanup`, and is therefore globally destructive to every E2E-labelled Docker container/network on that Docker daemon.

This means two separate runner invocations using only `setup` and `start` can avoid the runner's initial global cleanup. It does **not** make concurrent execution safe by itself: Compose-generated resources still need distinct identities and networks, and no cleanup command may be invoked while the other testnet is running.

### 17.2 Resource namespace constraints in the pinned implementation

The exact source confirms these relevant defaults:

- Docker IPv4 CIDR is hard-coded to `10.186.73.0/24`; IPv6 mode uses a fixed `fd80:b10c::/48`.
- Proxy host-port allocation starts at `5701` for every testnet; Prometheus proxy allocation starts at `6701`.
- Generated Compose services set literal `container_name: <node-name>` (and `<node-name>_u` for upgrade containers), bypassing normal Compose-generated container-name uniqueness.
- The generated network has an E2E label and a testnet-derived logical name; Compose invocation does not pass an explicit project name.
- The runner's full-run and benchmark paths invoke global cleanup before setup; the cleanup subcommand is also global.
- Per-node data directories are relative to the generated testnet directory, which does provide a useful data-path boundary.

The fixed subnets and default port ranges are source facts. Whether Docker rejects a particular overlapping subnet or a specific port collision depends on the actual host/runtime configuration; this audit does not claim those collisions were reproduced.

### 17.3 Viable harness options (not yet implemented)

**Option A — test-only fork/wrapper around the upstream E2E runner (preferred if a single Docker daemon is used).**

Use the pinned runner's setup/start/load/perturb/wait/test/stop capabilities, but replace its global cleanup with an ownership-scoped cleanup implementation. Before starting either network, allocate and validate disjoint CIDRs, proxy ports, monitoring ports, node/container names, Compose project names, and per-network output directories. Ensure the wrapper tracks exact created resource IDs and removes only those IDs. Do not rely on the broad `e2e=true` label for destructive cleanup.

The test-only fork must preserve upstream behavior relevant to consensus tests and keep the delta small and reviewable. It must include a test that starts A and B, invokes A cleanup, and proves B's containers, network, volumes, and block production remain intact.

**Option B — separate Docker daemons/engines.**

Running each testnet against a distinct Docker daemon can isolate Docker resource namespaces and make the upstream daemon-wide cleanup boundary narrower (one testnet per daemon). This is a candidate only: it adds host setup, daemon lifecycle, storage, networking, and resource-accounting complexity. It does not prove consensus isolation and still requires independent validation of host ports and CPU/memory contention. Do not choose it without confirming the target disposable environment supports multiple isolated daemons.

**Option C — native process harness.**

Run eight CometBFT processes with independent home directories, keys, ports, and explicit peer topology under a supervisor. This avoids Docker daemon-level cleanup coupling but requires the harness to implement reliable process supervision, readiness, restart, crash cleanup, network fault injection, and resource accounting. It is not the upstream E2E runner and should not be preferred merely to avoid Docker setup.

### 17.4 Recommended next sequence

1. Obtain a disposable Docker-capable Linux environment; do not use the production node or the user's normal workstation as the first destructive test target.
2. Build the exact `v0.38.26` upstream E2E runner in that environment and record toolchain/image digests.
3. Prototype only the test harness namespace layer (no Zion runtime changes): two manifests, eight distinct validator keys, distinct chain IDs/genesis, disjoint networks, host ports, container names, and output directories.
4. Exercise setup/start for A and B, verify both are simultaneously producing blocks, and record identities of all Docker resources.
5. Trigger A-only cleanup and assert B remains alive and advances height; then repeat with B-only cleanup.
6. Inject A-only validator kills, P2P partition, process pause, disk pressure, and CPU pressure while observing B's commit progress and state hash.
7. Repeat with reverse project order and crash/restart the harness itself to test orphan-resource recovery.
8. Only after those checks, run the full adversarial and resource matrix.

### 17.5 Evidence status

- Exact root full-run and benchmark pre-cleanup behavior: **verified by source inspection**.
- Exact `setup` and `start` subcommand behavior: **verified by source inspection**.
- Safe concurrent use of the stock runner on one Docker daemon: **not supported by current evidence; global cleanup and resource namespace issues remain**.
- A namespaced wrapper/fork: **proposed only, not implemented or tested**.
- Separate Docker daemons: **candidate only, not evaluated in a target environment**.
- Native process harness: **candidate only, not implemented**.
- No CometBFT source, Zion runtime, dependency, launcher, database, or migration was changed by this investigation.
