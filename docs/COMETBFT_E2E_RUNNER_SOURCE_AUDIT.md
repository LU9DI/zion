# CometBFT v0.38.26 E2E runner source audit

**Status:** read-only source audit; no Zion PoC was built or run  
**Pinned upstream source:** CometBFT tag `v0.38.26`, peeled commit `94d77f9f51a72e2b7d832798859f6222f08028f8`  
**Purpose:** determine whether the upstream E2E runner can directly prove simultaneous isolation of two Zion project committees.

## 1. Result

The upstream E2E runner is useful for generating and exercising individual CometBFT testnets, but its stock multi-testnet helper is **not a simultaneous multi-project isolation harness**. Source inspection found three concrete reasons:

1. `run-multiple.sh` executes manifests sequentially, not concurrently.
2. Each Docker testnet independently allocates the same default host-port ranges and uses manifest node names as global Docker container names. Concurrent testnets with overlapping node names therefore collide.
3. The runner's cleanup routine removes every Docker container and network carrying the generic `e2e=True` label, regardless of which testnet invoked cleanup. A failed or explicitly cleaned testnet can therefore destroy another concurrently running E2E testnet on the same Docker daemon.

These are source-level findings, not reproduced runtime failures. They are sufficient to reject the stock helper as-is for a concurrent two-project proof. They do **not** establish that CometBFT's consensus engine itself lacks project isolation.

## 2. Exact source findings

### 2.1 The multiple-testnet helper is sequential

At the pinned commit, `test/e2e/run-multiple.sh` documents that it runs each manifest sequentially and implements a plain `for MANIFEST in "$@"` loop. For each manifest it invokes one runner, and on failure it dumps logs and calls that testnet's cleanup before continuing.

Consequences:

- It never has two testnets under test concurrently.
- Success across several manifests is not evidence that project A continues committing while project B is partitioned, stopped, restarted, or resource-exhausted.
- It cannot measure concurrent resource contention or cross-project failure coupling.

Source: [run-multiple.sh at the pinned commit](https://github.com/cometbft/cometbft/blob/94d77f9f51a72e2b7d832798859f6222f08028f8/test/e2e/run-multiple.sh).

### 2.2 Docker names and host ports are not isolated per manifest

At the pinned commit:

- `test/e2e/pkg/testnet.go` initializes the host proxy-port generator from fixed constants for each newly constructed testnet. The default first ports are 5701 for RPC proxying and 6701 for Prometheus proxying.
- `test/e2e/pkg/infrastructure.go` creates Docker infrastructure data and assigns those ports to nodes in sorted-name order. A second independently constructed testnet starts allocation from the same constants.
- `test/e2e/pkg/infra/docker/docker.go` renders explicit `container_name: {{ .Name }}` values, explicit network names derived from the testnet name, and host mappings using those generated proxy ports.
- `test/e2e/pkg/testnet.go` derives the testnet name from the manifest filename's basename and its data directory from the manifest path without its extension.

Consequences:

- Two manifests that reuse node names can generate identical Docker container names.
- Two testnets can request the same host proxy ports (5701 onward and, when enabled, 6701 onward).
- Reusing a manifest basename can produce the same testnet/network name even when the manifests live in different directories.
- Separate manifest files and separate data directories alone do not guarantee collision-free concurrent Docker execution.

Sources:
- [testnet.go](https://github.com/cometbft/cometbft/blob/94d77f9f51a72e2b7d832798859f6222f08028f8/test/e2e/pkg/testnet.go)
- [infrastructure.go](https://github.com/cometbft/cometbft/blob/94d77f9f51a72e2b7d832798859f6222f08028f8/test/e2e/pkg/infrastructure.go)
- [docker.go](https://github.com/cometbft/cometbft/blob/94d77f9f51a72e2b7d832798859f6222f08028f8/test/e2e/pkg/infra/docker/docker.go)

### 2.3 Cleanup is daemon-global for the E2E label

At the pinned commit, `test/e2e/runner/cleanup.go`:

- removes all containers returned by `docker container ls -qa --filter label=e2e`;
- removes all networks returned by `docker network ls -q --filter label=e2e`;
- explicitly comments that this is done regardless of testnet;
- then removes only the invoking testnet's local directory.

The Docker Compose template labels each testnet's containers and network with the same generic `e2e: true` label. Cleanup does not scope the Docker removal to a Compose project, testnet name, manifest identifier, or per-run label.

Consequences:

- Running two independent E2E testnets concurrently on one Docker daemon is unsafe with the stock cleanup path.
- A failed testnet handled by `run-multiple.sh` can remove containers and networks belonging to a separately launched concurrent E2E run.
- A wrapper that merely launches two stock runners in parallel does not fix the problem; it increases the risk of cross-cleanup.

Sources:
- [cleanup.go](https://github.com/cometbft/cometbft/blob/94d77f9f51a72e2b7d832798859f6222f08028f8/test/e2e/runner/cleanup.go)
- [docker.go](https://github.com/cometbft/cometbft/blob/94d77f9f51a72e2b7d832798859f6222f08028f8/test/e2e/pkg/infra/docker/docker.go)

## 3. What the source audit does and does not prove

**Established by source inspection:**
- The stock multi-testnet script is sequential.
- Per-testnet port generators restart at the same fixed defaults.
- Docker container names are explicit node names, not namespaced by a unique run identifier.
- Docker networks use testnet-derived names.
- Cleanup removes all resources with the generic E2E label on the daemon.

**Not established:**
- Whether a modified runner with unique container names, unique network names, unique host ports, and scoped cleanup can safely run two networks concurrently.
- Whether separate CometBFT processes preserve the required Zion application-state and committee isolation under crashes, partitions, validator rotation, and resource exhaustion.
- Whether one process per project is affordable at Zion's intended project scale.
- Any BFT safety, liveness, or production-readiness claim.

No Docker runtime experiment was executed for this audit.

## 4. Required PoC harness changes before a concurrent test

Do not run two stock E2E runners concurrently against one shared Docker daemon. A safe disposable harness must, at minimum:

1. Assign a unique run/project prefix to every container name, Docker network, Compose project, generated directory, and host port.
2. Replace generic daemon-wide cleanup with exact per-run resource ownership and labels; cleanup must never remove another run's resources.
3. Allocate host ports dynamically or from disjoint pre-reserved ranges and fail before startup on any collision.
4. Keep each project's genesis, validator keys, node data, WAL, application state, RPC/P2P/ABCI endpoints, and test artifacts in separate roots.
5. Supervise and perturb each project independently, including stopping all validators in one project while verifying the other continues.
6. Record resource budgets and concurrent p50/p95/p99 latency before claiming the topology scales.
7. Preserve failed-run artifacts for diagnosis; cleanup must be an explicit, scoped action after evidence capture.

Prefer an isolated disposable Docker daemon/VM per project if the harness cannot safely namespace every resource on one daemon. This reduces shared-daemon interference but still does not replace application-level and consensus-level isolation tests.

## 5. Updated disposition for Zion

The pinned CometBFT release remains an **evaluation candidate only**. The existing [CometBFT project-isolation feasibility spike](COMETBFT_PROJECT_ISOLATION_FEASIBILITY_SPIKE.md) must treat the stock E2E runner as a source of single-testnet setup and test components, not as a ready-made concurrent two-project harness.

The next experiment must either:
- build a Zion-owned, disposable harness with per-project resource namespacing and scoped cleanup; or
- run each project in a separate isolated Docker daemon/VM and add an independent cross-project supervisor/test controller.

Do not claim two-project isolation from sequential runs. Do not modify CometBFT upstream, add a Zion consensus dependency, alter the official launcher, or change production runtime paths as part of this source audit.
