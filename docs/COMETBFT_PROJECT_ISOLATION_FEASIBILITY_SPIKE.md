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


## 18. Docker daemon targeting: a narrower isolation option, with host-level caveats

The exact pinned v0.38.26 runner source provides one additional orchestration fact relevant to Option B:

- test/e2e/pkg/exec/exec.go creates subprocesses with Go's os/exec.CommandContext and does not assign cmd.Env.
- test/e2e/pkg/infra/docker/docker.go invokes the literal docker executable for both Docker Engine commands and docker compose.
- With no explicit subprocess environment override, those Docker CLI processes inherit the runner process environment. Docker documents DOCKER_HOST as the daemon endpoint selector; the CLI also supports SSH daemon endpoints.
- Consequently, two runner processes can, in principle, be directed to different Docker daemons by giving each process a different DOCKER_HOST value. This avoids the stock runner's daemon-wide e2e cleanup crossing from one daemon into the other, provided the endpoints truly identify distinct daemons and neither process overrides the endpoint through a higher-precedence Docker context/CLI setting.

This is a source-and-documentation-derived orchestration capability, not an executed test. It narrows the feasibility question for Option B but does not make two daemons on one host automatically safe:

1. The Compose template publishes fixed host ports derived from each manifest. Distinct daemons on the same host still share the host's port namespace; their published ports must be disjoint.
2. Separate daemons on one Linux host may still interact with host routing, firewall/NAT rules, and overlapping bridge subnets. The stock runner's fixed IPv4/IPv6 ranges therefore remain an unresolved host-level risk even if daemon resource namespaces differ.
3. Daemon lifecycle, data roots, PID files, sockets, storage drivers, firewall rules, and API endpoint permissions must be independently configured. Docker's own daemon guidance warns that multiple daemons require separate configuration and care around iptables/rules.
4. A remote daemon reached over SSH or TLS adds an administration endpoint and credentials to the test environment. It is acceptable only as disposable test infrastructure, never as a Zion runtime dependency or correctness authority.
5. Each runner must be pinned to its intended daemon endpoint for its entire lifetime; test logs must record the endpoint identity and verify it before every destructive command. A context or CLI flag that overrides DOCKER_HOST must be prohibited or detected.

### Revised Option B recommendation

For the first concurrency experiment, prefer two separate disposable Linux VMs/hosts, each with one Docker daemon and one runner process, rather than two daemons sharing one host. Give each VM its own network and host-port namespace, unique testnet directory, and isolated disposable credentials. Use the stock runner only inside its own daemon; do not run a full-run, benchmark, or cleanup command against a daemon containing another testnet.

A same-host multi-daemon prototype remains a secondary experiment only after its port, subnet, route, firewall, storage, and daemon-lifecycle isolation are explicitly configured and tested. It must not be assumed safe merely because DOCKER_HOST differs.

### Evidence and status update

- Runner subprocess environment inheritance: verified by exact pinned source inspection (cmd.Env is not assigned).
- Docker CLI daemon selection through DOCKER_HOST / SSH endpoint: documented by Docker.
- Separate daemon targeting by two runner processes: feasible in principle; not executed.
- Same-host multi-daemon network/port isolation: unverified.
- Two-VM/two-daemon experiment: recommended; not provisioned or executed.
- No Docker daemon, CometBFT node, PoC, or E2E test was run in this session.
- No Zion runtime, dependency, launcher, database, migration, or production code was changed.


## 19. Two-VM experiment protocol and objective acceptance gates

### 19.1 Scope and non-goals

This protocol evaluates whether two independent CometBFT testnets can make progress concurrently and remain isolated under faults and cleanup. It is a harness-feasibility experiment only. It does not select CometBFT as Zion's BFT protocol, establish a production topology, validate decentralized discovery, or authorize any Zion runtime integration.

Use the pinned upstream tag v0.38.26 and its E2E runner. Provision two disposable Linux VMs (VM-A and VM-B), each with exactly one Docker daemon dedicated to this experiment. Do not share a daemon with production workloads, unrelated testnets, or user data. Each VM must have its own host network namespace, Docker data root, Docker socket, and disposable test workspace. Do not mount production credentials, SSH keys, cloud credentials, or persistent user directories into the test VMs.

### 19.2 Preflight gate (all conditions mandatory)

Before building or starting any container, record and verify:

1. VM identity, OS/kernel, CPU count, memory limit, disk quota, network interface and assigned address for each VM.
2. Docker Engine and Compose versions, daemon endpoint, daemon ID, root/data directory, storage driver, bridge/network configuration, and whether the daemon is dedicated and disposable.
3. CometBFT tag, peeled commit, runner binary SHA-256, Go toolchain version, test image digests, and manifest SHA-256 values.
4. A and B have distinct testnet directory roots, chain IDs, genesis hashes, validator private keys, node IDs, and validator public-key sets. No key material is copied between networks.
5. Each VM can reach only the intended test endpoints. Document firewall rules and the exact inter-VM links required for each network. No implicit shared bridge, shared writable volume, or shared host directory is allowed.
6. The runner's Docker endpoint is fixed and logged for the entire invocation. Verify the endpoint with Docker daemon identity before any destructive command. Do not rely on DOCKER_HOST alone if a Docker context or explicit CLI option can override it.
7. Capture baseline CPU, memory, disk, network, open ports, Docker containers, networks, and volumes before the experiment.

If any item cannot be measured or verified, stop before container creation. Do not downgrade a failed preflight into a warning.

### 19.3 Baseline concurrent-liveness experiment

1. Build the exact upstream E2E runner and required test image on the disposable environment; record immutable digests.
2. Generate independent manifests for A and B, each with four validators, unique chain IDs/genesis, independent keys, and disjoint peer topology. Store manifests and generated data only in their VM's workspace.
3. Run setup and start on A and B independently. Avoid the root full-run and benchmark commands because their pre-cleanup behavior is destructive. Do not invoke global cleanup while another testnet may exist on the same daemon.
4. Verify all four validators in each network are live, connected to the intended peers, and reporting the expected chain ID and genesis hash.
5. Sample heights and commit hashes at a fixed interval for a predeclared observation window. Require both networks to advance continuously and independently; record height, block hash, validator participation, peer set, process restarts, resource use, and errors.
6. Verify that no A node has a peer connection to B and vice versa. Confirm each network's committed state and block hashes are internally consistent across its validators.

Do not count container health or RPC responsiveness alone as evidence of consensus progress. Block-height advancement and matching committed block identity across the network are mandatory.

### 19.4 Cross-network fault and cleanup matrix

Execute one fault at a time, restore the baseline, and repeat in reverse order:

| Case | Action confined to A | Required B invariant |
|---|---|---|
| F1 | Stop one A validator gracefully | B continues advancing and agreeing on committed blocks |
| F2 | Kill one A validator abruptly | B continues advancing; no A process or resource appears in B |
| F3 | Partition A's peer links | B remains connected internally and advances |
| F4 | Pause one A validator | B remains live and advances |
| F5 | Apply bounded CPU pressure to A | B remains within its predeclared liveness threshold |
| F6 | Apply bounded disk pressure inside A's VM quota | B remains live; no shared storage degradation |
| F7 | Stop and restart the A runner process | B's processes, network, data, and block progress remain intact |
| F8 | Run A cleanup on A's dedicated daemon | B remains live and advances; its resource inventory is unchanged |

Repeat F1-F8 with A and B swapped. Record fault start/end times, the affected resource IDs, both chains' heights and hashes, and all observed restarts or stalls. Define numeric liveness thresholds before execution; do not select them after seeing results.

### 19.5 Cleanup and orphan-resource checks

After each VM's own testnet is stopped, enumerate containers, networks, volumes, and testnet directories on that VM's dedicated daemon. Match every created resource to the pre-run inventory and recorded resource IDs. Confirm that cleanup removes only experiment-owned resources and leaves the daemon baseline unchanged. Simulate runner termination before cleanup and verify that the recovery procedure can identify only resources owned by that experiment. Never use a broad label-based cleanup on a shared daemon.

Because each daemon is dedicated to a disposable VM, destroying the entire VM is the final containment boundary if ownership cannot be proven. Do not attempt speculative cleanup against an ambiguous resource inventory.

### 19.6 Pass, fail, and inconclusive criteria

**PASS** requires all preflight gates; simultaneous block progress on both networks; matching committed block identities within each network; zero cross-network peers or shared writable state; all A-only faults and cleanup leaving B within the predeclared liveness threshold; symmetric B-only results; and complete resource accounting with no unexplained orphan or deletion.

**FAIL** includes any cross-network peer/session, chain/genesis/key collision, shared writable state, unexpected deletion or restart of the unaffected network, unexplained block divergence, or breach of the unaffected network's liveness threshold attributable to the other network's fault or cleanup.

**INCONCLUSIVE** applies when instrumentation is missing, the baseline is unstable, the observation window is incomplete, resource pressure exceeds the predeclared test envelope, or the runner/daemon endpoint cannot be proven. Inconclusive is not a pass and must not be summarized as successful isolation.

### 19.7 Required evidence bundle

Retain: VM provisioning manifests; daemon identity/configuration; OS/kernel and tool versions; upstream tag and source commit; runner and image digests; A/B manifest and genesis hashes; public validator identities (never private keys); pre/post resource inventories; timestamped height/hash samples; peer topology snapshots; fault injection logs; runner and node logs; CPU/memory/disk/network measurements; cleanup output; and a machine-readable pass/fail/inconclusive summary. Redact credentials and private key material.

### 19.8 Current execution status

- Protocol and acceptance criteria: documented.
- Disposable VMs provisioned: no.
- Runner/image built on target VMs: no.
- Concurrent two-network execution: not run.
- Fault/cleanup matrix: not run.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

**Gate:** do not implement a Zion CometBFT adapter or claim project-isolation feasibility until the full experiment passes on the target disposable environment and its evidence bundle is reviewed.


## 20. Compose project namespaces are not sufficient isolation

A read-only cross-check against the current Docker Compose documentation confirms that a distinct Compose project name is useful namespace separation, but it is not a complete isolation boundary for this pinned runner.

### 20.1 What a unique project name does provide

- Compose uses the project name to group and isolate resources it manages, including its default project network.
- A unique `-p` / `--project-name` value can allow the same Compose specification to be deployed more than once on one infrastructure, provided the specification does not override resource names and host-level resources do not collide.
- Compose applies canonical project labels to managed resources, which can help inventory resources by project.

### 20.2 Why it does not solve this runner's collisions

The pinned CometBFT v0.38.26 runner has already been source-audited to generate explicit `container_name` values from node names, fixed IPv4/IPv6 network ranges, and proxy/monitoring host-port ranges. These are not all made unique merely by changing the Compose project name:

1. An explicit `container_name` is a literal custom name, not a project-prefixed generated name. Two projects using the same literal name can still conflict on one daemon.
2. The runner's fixed subnets remain a host/daemon network-allocation concern; a project name does not allocate a disjoint CIDR.
3. Published host ports remain in the host's port namespace; separate Compose projects or Docker daemons on one host do not make duplicate host-port bindings safe.
4. The stock runner's broad E2E-label cleanup remains broader than one Compose project. Project labels do not narrow a cleanup routine that explicitly selects resources by a different, shared label.
5. Named volumes or networks declared with explicit top-level `name` values are used as-is rather than automatically project-scoped; any such resource must be inspected in the rendered configuration.

### 20.3 Required static checks before any container creation

For each independently generated A/B manifest and Compose configuration, the harness must record and compare:

- Rendered service/container names, including explicit `container_name` values.
- Project names and all rendered network, volume, and config/secret resource names.
- IPv4 and IPv6 subnets, gateways, static addresses, and network modes.
- Every published host IP/port/protocol tuple, including proxy and monitoring ports.
- Bind mounts, named volumes, host paths, and writable directories.
- All resource labels and the exact selectors used by setup, stop, and cleanup.
- The effective Docker context/endpoint and daemon identity used by the runner.

Reject the configuration before creating containers if any supposedly isolated host-level name, address, port, path, or cleanup selector overlaps. A rendered Compose configuration is a static preflight artifact, not runtime proof; the two-VM protocol and fault matrix in Section 19 remain mandatory.

### 20.4 Revised isolation rule

Do not accept “different Compose project names” as evidence of testnet isolation. For the first experiment, retain the two-disposable-VM / one-dedicated-daemon-per-VM boundary from Section 19. If a later same-daemon harness is evaluated, it must additionally rewrite and test all explicit resource names, allocate disjoint subnets and host ports, isolate writable paths, and replace broad cleanup with exact resource-ID ownership checks.

### 20.5 Evidence status

- Compose project-name resource grouping: verified against current official Docker documentation.
- Explicit container names and fixed runner resource ranges: source-audited in Sections 17–19.
- Unique project names alone preventing all runner collisions: **false**.
- A fully namespaced same-daemon harness: not implemented or tested.
- Two-VM isolation experiment: still not provisioned or executed.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed by this documentation update.

## 21. Disposable VM readiness and read-only evidence collection

This section turns the Section 19 preflight into a reproducible evidence checklist. It does not provision VMs, install Docker, pull images, create networks, or start containers. All commands below are intended for an administrator to run inside each already-provisioned disposable VM, before any experiment resources are created.

### 21.1 Isolation and operator safety

- Use two disposable Linux VMs, each dedicated to one testnet and one Docker daemon. The VM boundary, not a Docker context or project name, is the primary containment boundary.
- Do not use the official Zion node, a production host, the user's workstation, or a VM containing unrelated Docker workloads.
- Do not mount home directories, SSH agent sockets, cloud credentials, source-control credentials, production data, or host Docker sockets into test containers.
- Restrict VM console/SSH access to named experiment operators. Docker daemon control is effectively host-administrator access on a rootful daemon; never expose an unauthenticated TCP API. If remote administration is necessary, use a separately authorized SSH endpoint and record its identity.
- Rootless Docker may reduce daemon/container privilege exposure, but it is not a replacement for VM separation. Confirm its cgroup/resource-limit support and networking behavior on the selected OS before relying on it; do not silently change the experiment topology to accommodate it.
- Do not disable host firewalling globally. Permit only the explicitly documented experiment links and management channel. Keep management access separate from validator P2P links.
- Keep VM snapshots or rebuildable images available. Do not include private validator keys in evidence bundles; store disposable keys only inside their owning VM with restrictive permissions.

### 21.2 Read-only host inventory

Run separately on VM-A and VM-B, save the raw output with a UTC timestamp, and label the file with the VM identity. These commands inspect the host; they do not install or change software:

```sh
date -u +%Y-%m-%dT%H:%M:%SZ
hostnamectl
uname -a
id
nproc
free -h
df -hT
lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINTS
ip -brief address
ip route show
ip -6 route show
ss -lntup
systemctl is-active docker.service docker.socket
```

If a command is unavailable, record it as unavailable; do not install packages during evidence collection. Record the VM provider/hypervisor identifier and configured CPU, RAM, disk and network quotas from the provider control plane as a separate signed/exported artifact. Guest-visible capacity alone does not prove the configured quota.

### 21.3 Read-only Docker inventory

Only run these commands if Docker is already installed and the daemon is already provisioned for the experiment. Do not start or enable a daemon as part of this checklist.

```sh
docker version
docker context ls
docker context show
docker info
docker ps --all --no-trunc
docker network ls
docker volume ls
```

Record the effective context and daemon ID, server version, root/data directory, storage driver, security options, cgroup version/driver, default address pools, and daemon endpoint. Capture the full pre-experiment container/network/volume inventory. Redact registry credentials, authorization headers, certificates, tokens, and any environment values that may contain secrets. Do not publish raw `docker inspect` environment output without review.

If the daemon is rootless, explicitly record the rootless security option, user namespace, socket path, data directory, and whether cgroup v2 plus systemd are available for CPU/memory/PID limits. Rootless mode's networking and published-port behavior must be validated within the disposable VM before the experiment; it is not assumed equivalent to rootful networking.

### 21.4 Static manifest and Compose review

After the two independent manifests and Compose files have been generated in their respective VM workspaces—but before any `up`, `start`, or runner setup command—capture the rendered configuration:

```sh
docker compose -f <experiment-compose-file> config
```

The command must be run against the exact file and environment intended for that VM. Store the rendered output, manifest hash, Compose file hash, and the non-secret variable names/values needed to reproduce resource allocation. Redact secrets before sharing the evidence bundle. Do not use `docker compose config --environment` in a shared report unless its output has been reviewed for secrets.

Compare A and B artifacts for all Section 20 fields. Also confirm that every bind-mount source resolves inside that VM's dedicated experiment workspace, every named volume is owned by that testnet, no service uses host networking unless explicitly justified, and no service receives the host Docker socket. A static render cannot prove runtime routing or isolation; those remain runtime test obligations.

### 21.5 Evidence manifest and preflight decision

Create one evidence index per VM containing:

- VM provider identifier, VM name, image ID, region/zone, creation timestamp, and declared resource quotas.
- UTC collection timestamp and SHA-256 of every raw inventory artifact.
- OS/kernel, Docker client/server, Compose, cgroup and storage-driver versions/settings.
- Effective Docker context/endpoint and daemon ID; never include private endpoint credentials.
- Baseline ports, routes, interfaces, firewall policy, containers, networks, volumes and writable mount inventory.
- CometBFT source tag/commit, Go toolchain, runner digest and image digests once built.
- Manifest/Compose hashes and a reviewed redacted rendered configuration.
- Operator identity and a record of any unavailable measurement.

The preflight result must be exactly one of:

- **READY** — every mandatory field is evidenced, both VMs are disposable and dedicated, and static A/B collision checks pass.
- **BLOCKED** — any required field is missing, the daemon/VM is shared or ambiguous, secrets are exposed, or any resource/network overlap is detected.

There is no warning-only state and no partial container creation. A READY inventory authorizes only the next controlled build/setup step; it is not evidence of consensus isolation or a pass of the Section 19 experiment.

### 21.6 Evidence status

- Checklist and read-only command set: documented.
- VM-A/VM-B identities, quotas and inventories collected: no.
- Docker daemons provisioned or inspected for this experiment: no.
- CometBFT runner or images built: no.
- No infrastructure was provisioned or modified by this documentation step.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.


## 22. Runner Compose lifecycle and implicit project identity

A read-only inspection of the pinned upstream source at CometBFT v0.38.26 adds a second namespace concern beyond the explicit resource collisions in Section 20.

### 22.1 Source facts

The upstream file `test/e2e/pkg/infra/docker/docker.go` (blob `c3588c0930d9e6a59daf39b1226b37217c99285e`) shows:

- `Provider.Setup` renders the Compose document and writes it to `<Testnet.Dir>/docker-compose.yml` with mode `0644`.
- `StartNodes` invokes `docker compose -f <Testnet.Dir>/docker-compose.yml up -d <node names...>`.
- `StopTestnet` invokes `docker compose -f <Testnet.Dir>/docker-compose.yml down`.
- The command builder does not pass `-p/--project-name` or `--project-directory`.
- The generated services use explicit `container_name` values derived from node names, the generated network is named from the testnet name, and node data is bind-mounted from paths relative to the Compose file directory.
- Proxy and monitoring ports are rendered from the testnet/node configuration; the ordinary P2P and profiling entries are container-port-only entries in the Compose template.

The upstream file `test/e2e/pkg/exec/exec.go` (blob `b0a3228fac652fafd9de5dee1d8707643c32c57b`) constructs subprocesses with `os/exec.CommandContext` and does not assign `cmd.Env`. The runner therefore inherits the parent process environment. This is consistent with the environment-selection risk already recorded in Section 18; it does not by itself prove which Docker context wins for every invocation.

### 22.2 Consequences for concurrent runs

- Without an explicit project name, Compose derives the project name from the Compose project directory (normally the directory containing the Compose file). Two different absolute testnet paths with the same final directory name can therefore resolve to the same implicit project name on a shared daemon.
- A distinct absolute workspace path does not repair literal `container_name` collisions or fixed host-port/subnet overlaps described in Section 20.
- `down` is scoped to the effective Compose project, not to an independently verified experiment ownership manifest. If two runs accidentally resolve to the same project name, stopping one can affect resources belonging to the other.
- The generated bind mounts are relative to the Compose project directory. Their actual resolved host paths must be captured from the rendered configuration and checked against each VM's dedicated experiment workspace.
- `Setup` writes the Compose file before start; a pre-existing or shared testnet directory is not an acceptable isolation boundary. Each run must have a fresh, exclusive workspace inside its own disposable VM.

### 22.3 Required additional preflight checks

Before any runner setup/start operation:

1. Record the canonical absolute `Testnet.Dir` for each run and the final directory component used by Compose's implicit project-name derivation.
2. Calculate the effective Compose project name using the exact Compose version and invocation environment; do not infer it only from a human-readable testnet name.
3. Require unique project names on any shared daemon, while still treating the daemon/VM boundary as the primary isolation control.
4. Verify that each testnet directory is fresh, exclusively owned by that run, and contains no pre-existing Compose file, node data, or symlinked path components.
5. Render and archive the exact Compose configuration; verify resolved bind-mount sources, explicit container names, network names, host-port bindings, and all cleanup selectors.
6. Record the effective Docker context and daemon identity immediately before each potentially destructive command. Environment inheritance must be explicit in the run record; do not rely on an operator's interactive shell defaults.

These checks are additive. They do not make a shared-daemon topology acceptable without the Section 19 fault/cleanup experiment and the Section 20 resource-collision checks.

### 22.4 Evidence and status

- Compose lifecycle and command construction: source-inspected at the pinned v0.38.26 tag.
- Implicit project-name derivation: corroborated by the official Docker Compose project-name documentation.
- Same-daemon collision caused by equal directory basenames: derived from the documented naming rule; not experimentally exercised.
- Runner invocation under two simultaneous testnets: not executed.
- No VM, Docker daemon, container, network, or volume was provisioned or changed.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.


## 23. Global E2E cleanup is unsafe for concurrent runs on a shared daemon

A read-only source inspection of the pinned CometBFT v0.38.26 runner identified a destructive cleanup scope that is broader than the selected testnet.

### 23.1 Exact source behavior

The upstream file `test/e2e/runner/cleanup.go` (blob `852612312bebbd1d89ea52134a89b8c4d69bde8e`) defines:

- `Cleanup(testnet)` first calls `cleanupDocker()`, and only after that succeeds calls `cleanupDir(testnet.Dir)`.
- `cleanupDocker()` runs `docker container ls -qa --filter label=e2e | xargs ... docker container rm -f`.
- It then runs `docker network ls -q --filter label=e2e | xargs ... docker network rm`.
- The source comment explicitly says that it removes all E2E resources with label `e2e=True`, regardless of testnet.
- The selected testnet directory is handled separately: `cleanupDir` checks the directory, runs a temporary `cometbft/e2e-node` container with the directory bind-mounted to remove nested contents, and then calls `os.RemoveAll(dir)`.

The upstream file `test/e2e/runner/main.go` (blob `23c14a1833dc837ad42a311c7c31070154bfa3cd`) shows that:

- The root full-run command invokes `Cleanup(cli.testnet)` before `Setup`, and invokes it again after successful tests unless `--preserve` is selected.
- The `benchmark` command also invokes `Cleanup(cli.testnet)` before setup and after the benchmark.
- The explicit `cleanup` subcommand invokes the same `Cleanup(cli.testnet)`.
- The separate `stop` subcommand calls the provider's Compose `down`, which is project-scoped; this does not change the global scope of `cleanupDocker()`.

### 23.2 Isolation consequence

The label filter is not scoped by testnet identity, Compose project, workspace, or experiment owner. Therefore, on a shared Docker daemon:

- Starting a full runner or benchmark can forcibly remove another experiment's labeled containers before the current testnet is set up.
- Its cleanup can also remove the other experiment's labeled networks.
- The explicit `cleanup` subcommand has the same cross-testnet effect.
- A unique Compose project name or a unique workspace directory does not constrain these global label-based deletion commands.
- Running independent CometBFT experiments concurrently against one daemon is unsafe with this upstream cleanup behavior, even if ordinary Compose resource names are unique.

This is a source-proven destructive-scope issue, not merely a theoretical name-collision risk. No destructive command was executed during this audit.

### 23.3 Required containment and experiment policy

For the planned isolation feasibility experiment:

1. Treat one dedicated disposable VM and one Docker daemon per concurrent testnet as mandatory containment. Do not share a daemon between independent testnets while using the unmodified upstream runner.
2. Never run the full runner, benchmark, or explicit `cleanup` command on a daemon that contains resources outside that single disposable experiment.
3. Capture the pre-run container/network inventory and daemon identity before any runner invocation; preserve the evidence outside the VM.
4. Keep the testnet directory exclusive to one run and verify its canonical path before cleanup, because `cleanupDir` removes that directory recursively.
5. If a future isolated-daemon experiment is impossible and shared-daemon execution is proposed, first design and review a source-level cleanup correction that scopes deletion to a cryptographically or otherwise unambiguously owned experiment namespace; do not patch upstream behavior speculatively or treat labels alone as a security boundary.
6. Test cleanup failure, partial failure, interrupted execution, and repeated cleanup only inside disposable VMs, with sentinel resources that must survive outside the experiment's ownership boundary.

A per-run Compose project name remains useful for ordinary Compose lifecycle operations, but it cannot neutralize the runner's global label-based cleanup.

### 23.4 Evidence and status

- Global container/network cleanup scope: source-inspected at the pinned v0.38.26 tag.
- Full-run and benchmark cleanup call sites: source-inspected at the pinned v0.38.26 tag.
- Selected testnet directory deletion behavior: source-inspected; no filesystem cleanup was executed.
- Cross-testnet deletion on one shared daemon: directly implied by the global label selectors; not experimentally exercised.
- No runner, Docker command, VM, container, network, or volume was executed, provisioned, or modified.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 24. Cleanup path derivation, writable bind mount, and partial-failure states

A further read-only inspection of the pinned CometBFT v0.38.26 sources identifies a second cleanup boundary: the runner derives the deletion target from the caller-supplied manifest filename, then uses a writable Docker bind mount before recursively removing that path.

### 24.1 Exact source behavior

The upstream file `test/e2e/pkg/testnet.go` shows:

- `LoadTestnet(file, ...)` calls `LoadManifest(file)` and passes the same `file` string to `NewTestnetFromManifest`.
- `NewTestnetFromManifest` sets `dir := strings.TrimSuffix(file, filepath.Ext(file))`, then assigns that value directly to `Testnet.Dir`.
- This derivation does not itself canonicalize the path, constrain it to a dedicated scratch root, or reject symlinked path components.

The upstream file `test/e2e/runner/cleanup.go` shows:

- `cleanupDir` rejects an empty path, calls `os.Stat(dir)`, and returns early only when the path does not exist.
- It then computes `filepath.Abs(dir)` and runs Docker with `-v <absolute-path>:/network`, without a read-only mount option, executing `rm -rf /network/*/`.
- Only after that Docker command succeeds does it call `os.RemoveAll(dir)`.
- The bind-mounted directory is therefore intentionally writable by the cleanup container. Docker documents that bind mounts are writable by default and can modify or delete host files through the mount.

These observations establish the path flow and write capability. They do not, by themselves, prove a remotely exploitable path traversal: the manifest path is a runner invocation input, and exploitability depends on who controls that input, filesystem layout, daemon privileges, and execution environment.

### 24.2 Cleanup partial-failure states

The ordering in `Cleanup` and `cleanupDocker` creates non-atomic outcomes:

1. Container removal runs before network removal. If container removal succeeds but network removal fails, the function returns before directory cleanup; some Docker resources may already be gone while the testnet directory remains.
2. If both global Docker cleanup steps succeed but the temporary cleanup-container invocation fails, `cleanupDir` returns before `os.RemoveAll`; the directory remains, although the global labeled containers and networks have already been removed.
3. If the cleanup container succeeds but `os.RemoveAll(dir)` fails, the contents selected by the container-side glob may already have been deleted while the directory itself or entries not matched by that glob remain.
4. There is no transaction or rollback across Docker container removal, network removal, container-side file deletion, and host-side `os.RemoveAll`. Retrying cleanup repeats the global label-based Docker deletion.

The exact surviving state after a failure depends on which command completed and on the directory contents. The runner does not provide an atomic cleanup guarantee.

### 24.3 Required path and privilege controls

Before any controlled runner experiment:

1. Use a dedicated, pre-created scratch root inside the disposable VM. Require the manifest and derived testnet directory to be strict descendants of that root; reject empty, root, home, repository, shared, and otherwise sensitive paths.
2. Canonicalize and validate the manifest and target paths before runner invocation. Reject symlinks/reparse points in every relevant path component and verify the target's filesystem identity immediately before destructive cleanup; string-prefix checks alone are insufficient.
3. Ensure the derived target is a dedicated per-run directory, not a parent directory, mount point, shared workspace, or path containing unrelated data. Keep evidence outside the target.
4. Treat the cleanup container as a privileged file-deletion helper: the writable bind mount must expose only the disposable per-run directory. Never mount a home directory, repository root, host root, credentials, Docker socket, or production data.
5. Keep one disposable VM and one Docker daemon per concurrent testnet while the upstream global label cleanup remains unchanged. The path controls do not mitigate cross-testnet Docker resource deletion.
6. Record the exact manifest path, derived `Testnet.Dir`, canonical target, filesystem identity, Docker context/daemon identity, and pre-cleanup inventories. On any mismatch or uncertainty, block before invoking the runner.
7. Exercise container-removal failure, network-removal failure, cleanup-container failure, host-side removal failure, interrupted cleanup, and repeated cleanup only with disposable scratch data and sentinel files/resources outside the owned target. Preserve evidence of each intermediate state.

A future source-level cleanup redesign should use an explicitly owned experiment root and scoped resource ownership, with path-safe deletion primitives appropriate to the target operating systems. Do not treat a simple canonical-path string check or a lock file as a substitute for filesystem identity and race-resistant containment.

### 24.4 Evidence and status

- Manifest-to-directory derivation: source-inspected in the pinned v0.38.26 `test/e2e/pkg/testnet.go`.
- Writable bind mount and deletion order: source-inspected in the pinned v0.38.26 `test/e2e/runner/cleanup.go`.
- Partial-failure ordering: directly follows the inspected sequential error-return paths; not experimentally exercised.
- Exploitability against an untrusted manifest or attacker-controlled filesystem: not established by this source review and remains environment-dependent.
- No manifest was executed, no cleanup was invoked, and no filesystem or Docker resource was deleted or modified.
- No VM, Docker daemon, container, network, or volume was provisioned or changed.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 25. Setup path containment, partial generation, and deterministic test keys

A read-only inspection of the pinned v0.38.26 `test/e2e/runner/setup.go`, `test/e2e/pkg/testnet.go`, `test/e2e/pkg/infra/docker/docker.go`, `p2p/key.go`, and `privval/file.go` identifies additional pre-start risks.

### 25.1 Manifest node names are filesystem path components

The manifest's `node` table is iterated by name in `NewTestnetFromManifest`. That name is assigned to `Node.Name`. The validation in `Node.Validate` rejects an empty name, but the inspected validation does not enforce a path-component allowlist, reject separators or traversal components, or establish containment beneath the testnet directory.

In `Setup`, the runner constructs each node directory with:

```go
nodeDir := filepath.Join(testnet.Dir, node.Name)
```

It then creates `config`, `data`, and `data/app` below that path and writes node configuration and key material there. Consequently, a manifest-controlled node name containing path traversal components can cause the joined path to resolve outside the intended testnet directory, subject to the manifest and infrastructure data being accepted by the caller. This is a concrete path-construction hazard; no exploit was executed, and reachability depends on who controls the manifest and runner invocation.

The same node names are interpolated into the generated Compose YAML as service keys, `container_name` values, and volume paths. The inspected template does not quote or independently escape those values. This creates a separate configuration-integrity concern if node names are not restricted before template rendering; actual YAML injection or Compose behavior was not experimentally established.

### 25.2 Setup is not an atomic or exclusive directory creation

The inspected `Setup` sequence:

1. Calls `os.MkdirAll(testnet.Dir, os.ModePerm)`, accepting an existing directory rather than requiring a newly created, exclusively owned per-run directory.
2. Calls the infrastructure provider's `Setup`, which writes `docker-compose.yml` into that directory.
3. Generates genesis and then creates node subdirectories with `os.MkdirAll`.
4. Writes configuration, application configuration, genesis, node identity keys, validator keys and signing state as subsequent operations.

There is no transaction or rollback covering these steps. An error after earlier writes can leave a partially generated directory and Compose file. Re-running setup can encounter or overwrite pre-existing content. The inspected path creation also does not establish that pre-existing path components are not symlinks or that the directory is exclusively owned by this run.

Some private-key writes do use restrictive file modes: `NodeKey.SaveAs` requests mode `0600`, and FilePV key and signing-state persistence use atomic writes with mode `0600`. That is useful file-level protection, but it does not establish safe parent-directory ownership, path containment, or race-resistant creation. The setup code also creates directories with `0755` and writes application configuration with `0644`; these are not private-key files, but their exposure and integrity still depend on the containing directory and host permissions.

### 25.3 E2E key generation is deterministic and unsuitable for real identities

The pinned E2E source defines a fixed `randomSeed` and initializes its key generator with `math/rand.New(math/rand.NewSource(seed))`. The generator reads key seed bytes from that deterministic pseudorandom stream and derives validator and P2P private keys from them. `NewTestnetFromManifest` uses this generator for both `PrivvalKey` and `NodeKey`.

This is test-fixture behavior, not secure production key generation. Anyone who knows the public source and reproduces the same manifest and generation order can reproduce those test keys. These keys must never be copied into a real Zion network, used as persistent production identities, or treated as entropy generated by a secure random source. A production identity lifecycle must use an OS-backed cryptographically secure random source and separately validated secure persistence; this E2E harness does not provide that guarantee.

### 25.4 Required controls before any experiment

1. Restrict node names to a small explicit allowlist, for example ASCII letters, digits, and single hyphens, with length limits; reject `.`, `..`, path separators, control characters, YAML metacharacters, and duplicate normalized names.
2. Independently validate the final resolved node directory as a strict descendant of a dedicated scratch root. Use filesystem-aware, race-resistant containment checks; do not rely on string-prefix checks.
3. Create a fresh per-run root with exclusive ownership. Reject existing targets and symlink/reparse-point components; verify filesystem identity immediately before writes and before cleanup.
4. Render Compose configuration only after validating every interpolated field. Parse the rendered Compose model and archive its exact content and hash before any container creation.
5. Make setup fail closed on any pre-existing unexpected file, directory, mount point, or Compose file. Prefer staging in a newly created private directory followed by an atomic publication step where the platform supports it; define crash recovery and no-overwrite semantics explicitly.
6. Propagate errors rather than allowing panics from configuration/key save helpers to leave ambiguous partial state; preserve a clear failed-run marker and never automatically reuse a partial directory.
7. Keep deterministic E2E keys confined to disposable tests. Production keys must be generated independently with cryptographically secure randomness and a separately reviewed identity persistence/backup/rotation design.
8. Add adversarial tests for traversal names, absolute and relative paths, symlinked ancestors, pre-existing files, concurrent setup, process interruption between each write, and rerun after partial failure. Run them only in isolated disposable environments.

### 25.5 Evidence and status

- Node name source and current validation: source-inspected in pinned v0.38.26 `test/e2e/pkg/testnet.go`; validation checks nonempty names but no path-component policy was found in the inspected `Node.Validate`.
- Node directory construction and setup ordering: source-inspected in `test/e2e/runner/setup.go`.
- Compose interpolation and relative node mounts: source-inspected in `test/e2e/pkg/infra/docker/docker.go`.
- Deterministic key derivation: source-inspected in `test/e2e/pkg/testnet.go`; fixed seed and `math/rand` generator.
- Private-key file modes: source-inspected in `p2p/key.go` and `privval/file.go`; no filesystem permission test was run.
- Traversal, YAML injection, symlink races, partial-write recovery, and concurrent setup: not experimentally tested; exploitability depends on caller control and filesystem conditions.
- No manifest was executed, no key was generated by this audit, and no file outside the documentation was created, modified, or deleted.
- No VM, Docker daemon, container, network, or volume was provisioned or changed.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 26. Compose interpolation, deterministic address allocation, and host-port validation gaps

A further read-only inspection of the pinned v0.38.26 sources `test/e2e/pkg/infra/docker/docker.go`, `test/e2e/pkg/infrastructure.go`, `test/e2e/pkg/testnet.go`, and `test/e2e/pkg/manifest.go` identifies additional validation gaps at the manifest-to-Compose boundary.

### 26.1 Unescaped values are interpolated into Compose YAML

The Docker provider uses Go `text/template` to render the Compose document. The inspected template inserts these values directly into YAML syntax without YAML scalar quoting or a YAML-aware encoder:

- `Testnet.Name` as the network key;
- `Node.Name` as the service key, `container_name`, and two bind-mount source paths;
- `Node.Version` as the image reference;
- `Testnet.UpgradeVersion` as the upgrade image reference and as the comparison value deciding whether upgrade services are emitted;
- `Node.InternalIP` as the static network address.

The testnet name is derived from the manifest path's directory basename. Node names and version strings originate in TOML manifest fields. The inspected `Node.Validate` checks that a node name is nonempty, but does not apply a YAML-safe identifier grammar; it also does not validate the image-reference syntax of `Version` or `UpgradeVersion`. Go `text/template` performs text substitution here; it does not provide YAML escaping.

This is a configuration-injection and malformed-rendering surface when a manifest or its path is not fully trusted. The source inspection does not establish a working YAML injection payload or a container escape. No malicious manifest was rendered or passed to Docker.

Required controls: constrain network and node identifiers to a documented ASCII allowlist and length bound; validate image references against an explicit accepted grammar; generate YAML using a YAML data model/serializer rather than string interpolation; parse the exact rendered Compose document and reject unexpected services, keys, mounts, networks, labels, commands, and ports before any Docker operation.

### 26.2 Docker address allocation is fixed and has no cross-run subnet allocator

The pinned `infrastructure.go` defines fixed Docker networks:

- IPv4: `10.186.73.0/24`
- IPv6: `fd80:b10c::/48`

Every call to `NewDockerInfrastructureData` selects the same CIDR for the same IP family. There is no lookup of existing Docker networks, no reservation/lease mechanism, and no per-testnet subnet selection in this function. Separate testnets attached to the same daemon therefore request overlapping address space; a unique Compose project name does not make those CIDRs disjoint. This compounds the already documented global cleanup and resource-ownership risks. One daemon per disposable VM remains the containment requirement for the unmodified runner.

The IPv4 generator starts after the first two addresses (commented as network and gateway) and increments sequentially. It has no explicit subnet-exhaustion or broadcast-address guard. `Testnet.Validate` checks only `IPNet.Contains`; that membership check does not by itself exclude the IPv4 broadcast address. For the fixed /24, the first 253 generated node addresses are .2 through .254; a 254th node would be assigned .255 and is not rejected by that containment check. Whether Docker rejects the rendered network configuration was not experimentally tested.

Required controls: allocate non-overlapping subnets per isolated daemon/experiment; check usable-host capacity before assigning nodes; explicitly reject network, gateway, broadcast, multicast, unspecified, and duplicate addresses as applicable to the selected family; reject exhaustion before producing infrastructure data; verify the final rendered IPAM model against the actual daemon inventory in a disposable environment.

### 26.3 Host-port generation is sequential but not fully bounded or cross-checked

The source initializes node proxy host ports at `5701` and Prometheus proxy host ports at `6701`, incrementing each generator sequentially. The generator detects only uint32 wraparound. The node validation rejects nonzero ports at or below 1024, but does not reject values above the TCP/UDP port maximum of 65535.

The collision checks compare proxy ports against other proxy ports and Prometheus ports against other Prometheus ports. They do not compare a node's proxy port against another node's Prometheus proxy port. With Prometheus enabled and sufficiently many nodes, the two sequential ranges can overlap: the 1001st proxy port is 6701, equal to the first Prometheus proxy port. This cross-category collision is not rejected by the inspected pairwise checks. The source also does not reserve the generated host ports against other processes or Docker projects on the host.

Required controls: validate every published host port as an integer in 1..65535 and apply the stricter policy required by the deployment; check uniqueness across all published host bindings, protocols, and host-IP scopes, including proxy-versus-Prometheus; detect generator exhaustion; reserve ports or use a daemon-mediated allocation strategy that cannot race with other host processes; render and inspect the final Compose port tuples before container creation.

### 26.4 Evidence and status

- Compose interpolation points and absence of YAML-aware encoding: source-inspected in `docker.go` (blob `c3588c0930d9e6a59daf39b1226b37217c99285e`).
- Fixed CIDRs, deterministic sequential IP assignment, and port-generator start values: source-inspected in `infrastructure.go` (blob `22f8e9ae0cfdbee8dc22fb434d537933204195f3`) and `testnet.go` (blob `41c5e4ae814e5691e767c86c01164127bef28b06`).
- Manifest origin of node version and node names: source-inspected in `manifest.go` (blob `7fd7afaf9d9ea84909709bed67688e761fe23f90`).
- IPv4 broadcast assignment and cross-category host-port collision: derived from the inspected generator and validation logic; not exercised against Docker or a live host.
- YAML injection, malformed image references, actual Docker rejection, subnet collision behavior, and host-port races: not experimentally tested.
- No manifest was executed; no Docker daemon, network, container, volume, VM, or host port was provisioned or changed.
- No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 27. Genesis validator admission, voting-power bounds, and update activation

A read-only review of the pinned v0.38.26 sources `test/e2e/pkg/testnet.go`, `test/e2e/runner/setup.go`, `test/e2e/app/app.go`, `types/genesis.go`, and `types/validator_set.go` found several important differences between manifest validation, genesis validation, and the runtime validator-set rules.

### 27.1 Explicit genesis membership is not checked against node mode

When `manifest.Validators` is present, `NewTestnetFromManifest` resolves each supplied name and adds that node to `Testnet.Validators`. It does not require the referenced node to have `ModeValidator`. The default path does select only nodes whose mode is validator.

This matters because `MakeGenesis` uses the selected node's generated private-validator public key for the genesis entry, while `MakeConfig` selects the dummy private-validator key for `full`, `light`, and `seed` modes. A manifest can therefore place a node in the consensus validator set while configuring its process not to sign with the corresponding key. A light node also exits setup before its node and validator key files are written. Such a mismatch can leave voting power assigned to a process that cannot contribute valid votes and can prevent the network from reaching quorum.

Required controls: require every positive-power genesis validator to be a node configured in validator mode; verify the configured signing protocol and key identity match the genesis public key; reject light/full/seed validator assignments before writing any files. If a test intentionally models an offline validator, express that as an explicit test scenario with expected liveness outcomes, not as an accidental mode mismatch.

### 27.2 Manifest validator powers are not validated at the testnet boundary

`Testnet.Validate` validates nodes and selected consensus parameters, but does not iterate through `Testnet.Validators` or `Testnet.ValidatorUpdates` to validate power values or aggregate voting power.

`MakeGenesis` calls `GenesisDoc.ValidateAndComplete`. That function rejects zero voting power, but the inspected implementation does not reject negative power or enforce `MaxTotalVotingPower` for the genesis list. CometBFT's `NewValidatorSet` later validates changes through `processChanges` and total-power checks; its constructor panics when the change set cannot be applied. Thus negative or excessive manifest powers can pass the earlier manifest/genesis checks and reach a later failure path instead of being rejected as a normal validation error.

The validator-set implementation also rejects duplicate validator addresses and invalid power values. The E2E manifest does not accept arbitrary public keys directly, so duplicate keys are not established as a user-controlled manifest exploit here; the generic genesis/validator-set boundary should nevertheless validate them before constructing a set.

Required controls: validate every initial power as a positive integer within the protocol limit; use overflow-safe aggregation and enforce the total-power ceiling before genesis publication; validate public-key uniqueness; return structured errors rather than relying on constructor panics. Apply the same rules to each scheduled update set, accounting for the current set and removals.

### 27.3 Empty genesis validator sets require an explicit height-zero bootstrap

The manifest comments explicitly permit an empty `validators = {}` set only when the application returns a validator update at height 0. The E2E application calls `validatorUpdates(0)` from `InitChain`; if no such entry exists, it returns no initial updates and CometBFT falls back to the empty validator list from genesis.

The manifest-to-testnet validation path does not enforce that the height-zero bootstrap exists or that it yields a nonempty valid set. This is a supported advanced scenario, but a missing or malformed bootstrap is not rejected at the earliest boundary.

Required controls: when the explicit initial validator set is empty, require a nonempty height-zero update; validate that the resulting set is nonempty, unique, positive-power, within the aggregate limit, and composed of nodes with matching validator-mode signing identities before setup proceeds.

### 27.4 Scheduled update heights and power types can silently diverge

Manifest update heights are parsed with `strconv.Atoi` and stored as signed `int64`, but `Testnet.Validate` does not reject negative heights or heights below `InitialHeight`. The application only looks up key `"0"` during `InitChain`, then looks up the current positive block height during `FinalizeBlock`. Negative heights, and positive heights lower than a chain's configured initial height, are therefore not reached by those lookups and can remain silently unapplied.

There is also a type mismatch: the manifest and `MakeAppConfig` carry update powers as `int64`, while the E2E application's `Config.ValidatorUpdates` decodes them as `uint8`. The CometBFT validator-update API and validator-set model use `int64`. Values above 255 cannot be represented by the app's current configuration type, even though the manifest accepts them and the protocol supports a much larger range. Such a configuration can fail during application config decoding rather than at manifest validation.

Required controls: allow only height 0 or positive heights at/after `InitialHeight`; use one consistent signed 64-bit power type end-to-end; reject negative powers, values above the protocol maximum, and aggregate overflow before writing app configuration; test add/update/remove operations and invalid heights with deterministic vectors.

### 27.5 Genesis time is wall-clock data, not reproducible fixture data

`MakeGenesis` sets `GenesisTime` using `time.Now()`. Within one setup invocation it builds one genesis document and writes that document to each node, so this does not by itself show an intra-run mismatch. Repeating setup from the same manifest at a different time produces a different genesis timestamp and therefore a different genesis artifact.

Required controls: for reproducible experiments, inject and record an explicit genesis timestamp or persist the generated genesis document as the experiment input; never let independent nodes independently choose genesis time. For a real Zion genesis ceremony, bind the timestamp and complete genesis bytes/hash into the signed ceremony manifest.

### 27.6 Activation timing and evidence boundary

The v0.38.26 E2E app emits height-zero validator changes from `InitChain` and later changes from `FinalizeBlock`. The CometBFT ABCI requirements specify that an update emitted after height H takes effect at H+2; H+1 commits the next-validator hash, H+2 activates the set, and H+3 reflects the new set in last-commit metadata. This activation delay must be represented explicitly in any Zion rotation protocol and its tests.

Evidence inspected:
- `test/e2e/pkg/testnet.go`, blob `41c5e4ae814e5691e767c86c01164127bef28b06`: manifest conversion, validator selection, update-height parsing, and `Testnet.Validate`.
- `test/e2e/runner/setup.go`, blob `25d9a70b6a3fedf264dddd595f6918946844553e`: genesis construction, node config, and app config generation.
- `test/e2e/app/app.go`, blob `9380f5dbc16100ba35f1ce172f7a9911d1bdb9e3`: `uint8` update-power decoding, InitChain height-zero update, and FinalizeBlock update lookup.
- `types/genesis.go`, blob `d6d0b2afaa4d140b3e9b0902655f29e122944217`: genesis validation scope.
- `types/validator_set.go`, blob `ebe92a760fd78a436fd2bbdef18ca405d43e70fe`: duplicate/power/aggregate checks and constructor panic behavior.
- ABCI update semantics and H+2 activation timing: CometBFT specification. See cited source in the accompanying review.

No malicious manifest, generated genesis, node process, or consensus network was executed. No runtime exploit, consensus failure, or production impact was experimentally demonstrated. No Docker/VM/network/volume was provisioned or changed. No Zion runtime, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 28. Validator signing-state durability, reset paths, and key custody

A read-only review of the pinned CometBFT v0.38.26 `privval/file.go`, `libs/tempfile/tempfile.go`, and `spec/consensus/wal.md` distinguishes useful local anti-double-sign safeguards from guarantees that a decentralized Zion validator lifecycle still needs to provide.

### 28.1 The default file signer stores the private key in plaintext

`FilePVKey.Save` serializes the private/public key pair to the configured key file and calls `tempfile.WriteFileAtomic(..., 0600)`. The file is therefore permission-restricted on supported filesystems, but it is not encrypted by this implementation. The CometBFT configuration documentation describes this as the default local signing-key storage method.

Required controls: production Zion must not treat mode 0600 as encryption or hardware-backed custody. Define an explicit signer adapter and threat model for OS keystore, TPM/HSM, or an independently reviewed remote signer; constrain access to key material, backups, crash dumps, snapshots, and operator credentials. Do not add a hosted CA or central key service as a mandatory dependency.

### 28.2 FilePV maintains H/R/S anti-equivocation state and persists before returning the signature

`FilePVLastSignState` stores height, round, step, signature, and canonical sign bytes. `CheckHRS` rejects height/round/step regression; at an identical H/R/S it only reuses the prior signature for identical sign bytes or the narrowly permitted timestamp-only difference, and otherwise returns a conflict. Both vote and proposal signing call `saveSigned`, which updates and saves this state before the signature is returned to the caller.

This is a valuable local guard, not a distributed lock or quorum protocol. Two processes holding the same private key but independent state files can each believe they are the sole signer. Copying a key to a second node, restoring an older state snapshot, or running blue/green instances without a fencing protocol can therefore invalidate the single-signer assumption.

Required controls: one active signing authority per validator key unless the selected signer protocol explicitly provides durable anti-equivocation across replicas. Enforce fencing during failover and key handoff; bind signer state to chain ID, validator public key, protocol version, and the committed validator-set epoch. Test concurrent requests, process crash, disk rollback, snapshot restore, network partition, and failover with adversarial schedules before production use.

### 28.3 Missing state fails closed in the normal loader, but explicit empty-state/reset APIs exist

`LoadFilePV` loads both the key and state files and exits on read or decode errors. That default path does not silently replace a missing state file with an empty state. However, the same package exposes `LoadFilePVEmptyState`, which deliberately loads a key with an empty last-sign state, and `FilePV.Reset`, whose source comment explicitly marks it unsafe and which clears the signing history before saving.

Required controls: production startup must never fall back to empty signing state after a missing, corrupt, stale, or inaccessible state file. Restrict reset/empty-state operations to isolated disposable testnets or a formally governed recovery ceremony that proves the validator key cannot resume signing against prior history. Backups must preserve key and anti-double-sign state as one versioned recovery unit; rollback detection must be explicit.

### 28.4 Atomic file replacement is not a complete crash-consistency proof

The v0.38.26 `WriteFileAtomic` helper creates a unique temporary file in the target directory using exclusive creation, synchronous writes, and the requested permissions, then closes and renames it over the destination. The helper does not explicitly fsync the parent directory after the rename. The consensus WAL specification separately says messages signed by the node are fsynced and that the WAL is replayed after a crash.

These mechanisms reduce important failure windows, but source inspection alone does not establish durability across every filesystem, storage controller, virtualized disk, power-loss, snapshot/restore, or directory-metadata failure mode. Nor does a WAL on one node provide cross-node signer fencing.

Required controls: validate the exact filesystem/storage stack and crash semantics; test abrupt termination and power-loss-equivalent faults in disposable environments; verify state and WAL recovery together; fail closed on uncertain recovery; document the recovery authority and prohibit rollback to an older signing state. Do not claim crash-safe anti-double-signing solely from atomic rename or WAL presence.

### 28.5 Key rotation is a protocol handoff, not a file replacement

The CometBFT file signer stores key material and last-sign state separately. Replacing only the key, restoring only one file, or starting a replacement signer before the validator-set update is committed can create an identity/state mismatch or concurrent signing authority. The validator-set activation delay recorded in section 27 also means an approved rotation is not active at the moment an application emits the update.

Required controls: define a project-scoped rotation state machine with proposal authorization, proof of possession by the new key, old-key authorization where policy requires it, committed activation height/epoch, signer fencing, recovery and revocation semantics, and an explicit point at which the old signer becomes unable to sign. Test lost acknowledgements, partitions, delayed activation, old/new signer overlap, rollback, and recovery. Governance approval alone is not BFT commitment.

### 28.6 Evidence and limitations

Evidence inspected at the pinned v0.38.26 tag:
- `privval/file.go`, blob `a092e38b08733b32dd058d094a99582b193b1d63`: key/state structures, H/R/S checks, normal and empty-state loaders, unsafe reset, signing and persistence order.
- `libs/tempfile/tempfile.go`, blob `f79cd0e16322d20dde1d66bcafcfca08bb9a8afc`: exclusive temporary-file creation, `O_SYNC`, mode propagation, close and rename; no explicit parent-directory fsync in this helper.
- `spec/consensus/wal.md`, blob `599d63d35537b3e7fe139682f4cea027e69ca9b0`: WAL fsync and replay description.
- CometBFT signer-state reference: last signed height/round/step plus signature and sign bytes; the state file is used with a local private validator.

No signer was instantiated, no key generated or rotated, no state file was modified, and no crash/recovery or double-signing experiment was executed. The findings are source-level observations and required design gates, not an experimentally demonstrated exploit or production certification. No Zion runtime, signer adapter, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 29. Remote signer protocol: chain binding, request authority, and isolation boundaries

A read-only review of the pinned CometBFT v0.38.26 `proto/tendermint/privval/types.proto`, `privval/signer_requestHandler.go`, `privval/signer_server.go`, and `privval/signer_dialer_endpoint.go` identifies the guarantees provided by the built-in remote-signing message handler and the guarantees it leaves to the transport and deployment.

### 29.1 The request schema binds a chain ID, but carries no project or validator-set epoch

The protobuf request variants are `PubKeyRequest`, `SignVoteRequest`, `SignProposalRequest`, and `PingRequest`. The first three carry a chain ID; vote and proposal requests carry the corresponding consensus object. The schema has no explicit Zion project ID, validator-set epoch, governance epoch, signer authorization scope, request nonce, or application-level expiry/fencing token.

The default handler compares the supplied chain ID with the server's configured chain ID before returning a public key or signing a vote/proposal. This is useful domain separation, but a chain ID is a caller-supplied string checked against server configuration; it is not proof that the caller is an authorized project member or that a particular validator-set epoch is active.

Required controls: a Zion signer boundary must bind every signing request to a canonical project identifier, chain ID, validator public key, committed validator-set epoch, message type, and exact canonical sign bytes. Authorization must be derived from committed project state, not merely a request field. Reject stale epochs, unknown projects, wrong keys, unsupported message types, and uncommitted rotations.

### 29.2 The default handler is not a project authorization engine

The handler validates the chain ID and delegates to `PrivValidator.SignVote` or `SignProposal`; public-key requests return the signer's key, and ping requests return a ping response. It does not consult Zion membership, governance, project admission, revocation tombstones, quorum certificates, or validator-set activation state.

A remote signer endpoint therefore must not be exposed as a generic signing oracle to untrusted peers. Network reachability and a matching chain ID are not equivalent to authorization.

Required controls: keep the signer on a narrowly scoped authenticated channel; authenticate the calling node/workload; authorize project and epoch on every request; bind signer key to the expected validator identity; rate-limit and bound request sizes; audit denials without leaking key material; fail closed if authorization state is unavailable. Do not make a central authorization server a mandatory final dependency: the authoritative authorization proof must be locally verifiable from committed decentralized state.

### 29.3 One SignerServer serializes its handler, but this is not cross-instance fencing

The inspected server holds a mutex while invoking its request handler, so one server instance processes its signing handler serially. This protects the handler's mutable state from concurrent calls through that instance. It does not coordinate two SignerServer processes, two endpoints, two machines, or a replacement signer started during failover. The underlying PrivValidator anti-double-sign state is still the decisive per-instance guard described in section 28.

Required controls: enforce one fenced signing authority per validator key, or use a formally specified threshold/MPC signer whose protocol guarantees non-equivocation across participants. A mutex, single TCP connection, or process-local queue is not a distributed anti-double-sign mechanism. Test parallel requests across independent processes and stale-primary failover.

### 29.4 Transport authentication is a separate layer and must be verified for the selected dialer

The protobuf schema does not define transport authentication. CometBFT supplies different socket dialer/listener choices; security depends on the exact dialer, listener, connection wrapper, key configuration, and deployment network boundary. The files inspected here do not justify a blanket claim that every remote-signer connection is authenticated or encrypted, nor that TCP/Unix transports provide equivalent protections.

Required controls: inventory the exact transport implementation selected by the runner/configuration. For TCP, require authenticated encryption and peer identity binding; reject unauthenticated plaintext exposure and public listener binding. For Unix sockets, validate filesystem ownership, mode, parent-directory permissions, mount namespace, and peer-credential policy. Test wrong peer keys, replay/reconnect, MITM, socket replacement, and unauthorized local processes. Keep transport peer identity distinct from the validator consensus key and from project authorization.

### 29.5 Ping and reconnection are availability signals, not authorization or replay protection

Ping requests contain no chain ID or project context. The dialer endpoint retries connection establishment, while the signer server accepts requests over the established connection. These behaviors support liveness and reconnect handling; they do not establish project membership, request freshness, committed epoch, or safe failover.

Required controls: attach authorization and freshness to each signing operation rather than relying on connection establishment or ping. Treat reconnect as a new authenticated session; invalidate old session state, prevent overlapping active sessions unless explicitly safe, and ensure retry after an uncertain response cannot produce a conflicting signature. Preserve the exact H/R/S and sign-bytes idempotency checks at the signer.

### 29.6 Evidence and limitations

Evidence inspected at CometBFT v0.38.26:
- `proto/tendermint/privval/types.proto`, blob `13190ca42fa2941efd357fa300c25938fd012629`: remote-signing message variants and fields.
- `privval/signer_requestHandler.go`, blob `85a59617bbe715a847ae859bd94e4f391c749898`: chain-ID comparison, public-key response, vote/proposal delegation, and ping behavior.
- `privval/signer_server.go`, blob `8c9abe717d451cd72a6e49e3eb737bb9806cad5c`: one-instance handler mutex and request loop.
- `privval/signer_dialer_endpoint.go`, blob `997c15750f64e414f9752bafcbd94609a6b48246`: reconnect loop and configurable retry count/interval.
- Official package documentation describes the remote signer client and socket endpoint model. See the linked reference in the review.

The exact TCP/Unix dialer and listener implementation was not fully inspected in this pass; transport authentication/encryption conclusions are deliberately left open. No remote signer was started, no request was sent, and no network attack or replay experiment was executed. This is source-level protocol analysis, not an exploit demonstration or security certification. No Zion runtime, signer adapter, consensus implementation, dependency, launcher, database, migration, or production configuration was changed.

## 30. TCP versus Unix remote-signer transport: authenticated encryption and local trust

A source-level review of the pinned CometBFT v0.38.26 `privval/socket_dialers.go`, `privval/socket_listeners.go`, and signer endpoint code resolves the transport question left open in section 29.

### 30.1 TCP uses SecretConnection for authenticated encryption

`DialTCPFn` establishes TCP, applies a handshake deadline, then wraps the connection with `p2p/conn.MakeSecretConnection` using the dialer's persistent private key. `NewTCPListener` wraps accepted TCP connections with the same SecretConnection mechanism using the listener's configured private key. The upstream SecretConnection protocol performs an ephemeral X25519 key exchange, derives authenticated encryption keys, and authenticates persistent public keys with signatures over a transcript challenge.

This is materially stronger than plaintext TCP: it provides encrypted transport and cryptographic peer authentication at the channel layer. It does not by itself authorize a peer for a particular Zion project, validator key, or committed validator-set epoch. The inspected remote-signer handler still only compares chain ID before signing. A listener must additionally pin or authorize the expected caller identity from committed project state; otherwise any party able to establish an accepted SecretConnection may reach the signing handler.

Required controls: use TCP only with SecretConnection or an independently reviewed mutually authenticated secure transport; pin/authorize the expected caller key and bind it to project, chain, validator key, and committed epoch. Verify both sides' identity expectations, key rotation, downgrade rejection, and replay behavior. Never treat encryption alone as project authorization.

### 30.2 Unix transport is explicitly unencrypted in this implementation

`DialUnixFn` uses `net.DialUnix` directly. `NewUnixListener` accepts the connection and wraps it only with read/write deadlines. The source comment says the connection is unencrypted and contains a TODO for an authentication MAC. Therefore the Unix transport in this tag does not provide cryptographic peer authentication or message encryption at this layer.

Unix sockets can still be appropriate inside a tightly controlled host boundary, but their security then depends on OS-enforced filesystem and process isolation. The source reviewed here does not establish that the socket path is created with restrictive ownership/mode, that parent directories cannot be replaced, or that peer credentials are checked.

Required controls: either add a reviewed authenticated channel for Unix sockets or restrict them to a hardened local trust boundary with dedicated unprivileged identities, restrictive socket and parent-directory permissions, protected mount namespaces, and OS peer-credential checks. Validate ownership/mode after bind and before every use; reject symlink/replacement attacks; test unauthorized same-host processes. Do not expose a Unix signer socket through a shared writable volume without an explicit access-control proof.

### 30.3 TCP handshake authentication is not the same as an allowlist

SecretConnection proves possession of the private key corresponding to the peer identity presented during the handshake. The remote-signer endpoint code reviewed here does not itself compare that identity to a project-scoped allowlist or authorization certificate. Authentication answers "which key is on this connection"; Zion must still answer "is this key authorized to request this signature for this project and epoch?"

Required controls: maintain an explicit, committed authorization binding from caller node identity to project membership and permitted signer operations. Validate the binding on each request or against a safely cached committed state with bounded staleness. Revocation must take effect according to a deterministic committed rule; stale or unavailable authorization must fail closed. Do not add a mandatory central CA or hosted identity service.

### 30.4 Connection replacement and retries leave an uncertain-outcome boundary

The listener endpoint accepts a connection, places it in an availability channel, and replaces/drops the active connection during reconnect. The retry client repeats signing operations after transport errors, except explicit remote-signer errors. If a signer completed and durably persisted a signature but the response was lost, the caller may retry the same operation. The local FilePV H/R/S guard can return the same signature for the same sign bytes, which is useful, but this is not a general operation-ID protocol and does not solve concurrent independent signers or stale-key failover.

Required controls: model every signing request as an idempotent operation bound to canonical sign bytes and H/R/S; after an uncertain response, retry only the exact same operation and retrieve/reproduce the exact prior result. Reject changed bytes at the same H/R/S. Reconnection must not silently transfer signing authority; use explicit fencing and committed key-epoch handoff. Test response loss after durable sign, reconnect during sign, duplicate requests, old connection overlap, and old signer resumption.

### 30.5 Resource and denial-of-service controls remain deployment obligations

The inspected listeners enforce accept/read/write timeouts and the endpoint caps an individual delimited remote-signer message at 10 KiB in this tag. These are useful bounds, but they do not alone establish global connection limits, per-identity quotas, handshake CPU budgets, listener backlog safety, or project-level fair scheduling. A peer able to repeatedly initiate handshakes or occupy the single accepted connection can affect signer availability.

Required controls: bound concurrent handshakes and connections, rate-limit by authenticated identity and network source, cap work queues and request sizes, isolate signer CPU/memory, and expose bounded telemetry without leaking signing material. Availability defenses must not allow unauthenticated callers to consume unbounded resources before authentication.

### 30.6 Evidence and limitations

Pinned CometBFT v0.38.26 source inspected:
- `privval/socket_dialers.go`, blob `d49231c72c08d062f261e792dc3e6c0c388e12b4`: TCP SecretConnection wrapper and direct Unix dial.
- `privval/socket_listeners.go`, blob `0be86453d259d9ae15b32e7820b9a997ec5e5ec4`: TCP authenticated-encryption wrapper; Unix plaintext wrapper and explicit authentication-MAC TODO; read/write/accept deadlines.
- `privval/signer_listener_endpoint.go`, blob `3a8525bab24ea2308e53334fee6a4b155e07911f`: accepted-connection lifecycle, ping and reconnect.
- `privval/signer_endpoint.go`, blob `84dbde8f3553266d431f8eed247102f60cdf5cc9`: connection replacement, framing, timeout handling, 10 KiB message cap.
- `privval/retry_signer_client.go`, blob `271e146474c8da6ddc382b85d1f9384ff876a11f`: retry behavior for signing calls.
- CometBFT SecretConnection protocol description: ephemeral X25519, transcript challenge authentication, and encrypted traffic.

No network listener was opened, no socket was created, and no handshake, unauthorized access, replay, or DoS test was run. The findings describe source behavior and design requirements; they do not establish a demonstrated exploit. No Zion runtime, signer adapter, dependency, launcher, database, migration, or production configuration was changed.

