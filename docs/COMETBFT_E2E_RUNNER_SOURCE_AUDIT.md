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


## 6. Zion CI network-smoke scope check

A separate read-only inspection of Zion's current `.github/workflows/cometbft-private-network-smoke.yml` found that the workflow is **not a CometBFT consensus smoke test** despite its display name.

Its executed network step:
- obtains the runner's Tailscale IPv4 address;
- starts Python's standard-library `HTTPServer` on TCP port 26656;
- resolves the peer hostname and checks that the address is in the Tailscale CGNAT range;
- performs an HTTP GET to `/health` and compares a fixed byte payload.

The workflow does not:
- install, build, or launch CometBFT;
- start a validator, consensus reactor, ABCI application, or testnet;
- exchange CometBFT P2P messages or consensus votes;
- submit transactions, observe block heights, verify commit certificates, or compare app hashes;
- partition a validator committee, stop a quorum, or test recovery.

Therefore a successful run of this workflow proves only bidirectional private TCP/HTTP reachability between the two configured ephemeral runners (one direction per matrix job). It is useful infrastructure evidence, but it is **not evidence of CometBFT consensus, project isolation, BFT safety/liveness, or Zion runtime integration**.

The workflow also has an explicit opt-in and isolated-tailnet readiness gate. When that gate is not configured, it records a skip and creates no tailnet node. A skipped run must not be reported as a successful network test.

**Required reporting rule:** keep the existing workflow's result labeled as a private runner connectivity smoke. Do not cite it as a CometBFT network/consensus test. A future consensus smoke must separately provision disposable test-only validators and an ABCI test app, verify committed heights/app hashes and commit evidence, and clean up only resources it owns. It must remain opt-in and isolated from production keys and runtime.


## 7. Private-runner workflow configuration and security-boundary audit

A read-only review of the complete workflow at the Zion PR branch found the following:

### 7.1 Controls present in the repository workflow

- The workflow requests only the GitHub Actions OIDC token permission (id-token: write); it does not check out repository code or request repository contents access.
- The Tailscale action is pinned to a full commit SHA rather than a mutable version tag.
- The action receives the OAuth client ID and audience through step-scoped environment/input values. The preflight checks presence only and writes a boolean to the step output; it does not print either value.
- Network execution is gated by both explicit repository opt-in and an isolated-tailnet readiness flag, as well as non-empty OIDC configuration.
- The responder binds to the runner's Tailscale IPv4 address rather than all interfaces. The client validates every resolved peer IPv4 address against the Tailscale CGNAT range and connects to the validated literal address.
- The HTTP handler exposes only a fixed /health response. The test uses a bounded connection timeout and overall retry deadline, and shuts down the local responder in a finally block.
- The two matrix entries test opposite directions. fail-fast: false allows the second direction to report independently if the first fails.

### 7.2 External trust and isolation assumptions not verified by this workflow

The repository YAML cannot establish that the external Tailscale control-plane configuration is safe. In particular, this audit did not inspect or verify:

- which principals can use the OAuth client and which tags that client is authorized to assign;
- whether tag:zion-ci is restricted to the intended CI identity and devices;
- the tailnet ACL/grant policy for TCP port 26656 and whether it permits only the two intended runner identities;
- whether the tailnet is genuinely isolated from production devices and other projects;
- device expiry/ephemeral-node policy, session cleanup, or revocation behavior after a job ends;
- whether the configured OAuth audience is restricted to the intended GitHub repository, workflow, branch, and environment claims.

The two boolean readiness variables are operator assertions, not cryptographic evidence of those external policies. A successful preflight therefore means only that the required values are present and the operator enabled the gate; it does not independently validate tailnet isolation or least privilege.

### 7.3 Protocol and reporting limits

The HTTP health responder has no application-layer authentication or challenge-response protocol. Its fixed payload is suitable only as a narrow reachability probe inside a correctly configured, access-controlled tailnet. It must not be exposed on a public interface or treated as proof of peer identity beyond the guarantees supplied by the Tailscale control plane and its ACL policy.

The workflow's static concurrency group serializes workflow runs in this repository; the two matrix jobs within one run may execute in parallel. This is a CI scheduling control, not a network isolation mechanism.

When the gate is false, the summary explicitly reports NOT RUN and no Tailscale join or HTTP test step executes. The final skip step is informational; its successful completion must not be interpreted as a passed connectivity check.

### 7.4 Required hardening before relying on this smoke as a security control

Before treating this workflow as a security control rather than an optional connectivity diagnostic:

1. Document and independently review the Tailscale OAuth client restrictions, tag ownership, ACL/grants, tailnet boundary, and device-expiry policy.
2. Bind the OIDC trust policy to the exact repository and intended workflow/ref/environment claims; do not rely only on the presence of client ID and audience strings.
3. Confirm that the two runner identities can reach only the intended peer and port, and cannot reach production or unrelated project networks.
4. Confirm ephemeral-device cleanup and revocation behavior with the actual Tailscale configuration and retain evidence of that check.
5. Keep the result name and summary explicit that this is private TCP/HTTP reachability only. A skipped run remains NOT RUN, never PASS.

Audit boundary: no Tailscale account, ACL, OAuth client, GitHub secret, repository variable, workflow execution, or runner configuration was accessed or changed during this review. The external policy items above remain unverified. This section is a source/configuration review, not a penetration test or proof of tailnet isolation.
