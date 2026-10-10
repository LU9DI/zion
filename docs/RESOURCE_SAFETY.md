# Resource safety contract

## Owner-controlled hard ceilings

The owner sets maximum CPU budget, memory budget, disk reservation, upload/download rates, concurrent jobs, battery policy, and thermal ceiling. Network messages may request less capacity but must never increase these limits.

## Adaptive behavior

- High host CPU or critical memory/disk pressure: pause background work.
- Moderate pressure: reduce the budget sharply.
- Temperature at or above the configured ceiling: pause.
- Unknown or unhealthy telemetry: fail closed.
- Battery operation: disabled by default.
- Production participation: disabled unless an OS-level enforcement adapter reports verified enforcement.

## Important limitation

The governor is a policy engine, not a kernel scheduler. A production implementation must use OS-specific process limits and test them under stress. It must not claim imperceptible impact until measurements support that claim on each supported platform. Storage removal must preserve data until replica receipts or retention rules permit deletion. When host activity changes, cancel nonessential jobs promptly and resume gradually with jitter.

## Partial OS enforcement adapter (v0.4.0)

`src/os-enforcement.js` introduces an experimental Linux cgroup v2 adapter for a separately launched worker. It sets and reads back `cpu.max`, `memory.max`, and `pids.max`, and can attach a worker PID only after those limits have been verified. The parent cgroup must be explicitly delegated and writable by the service administrator. The adapter never runs commands through a shell and does not create a cgroup outside the configured direct child path.

This adapter is intentionally marked `complete: false`: cgroups alone do not enforce disk I/O or network bandwidth here, and this project still lacks trustworthy cross-platform thermal and user-activity enforcement. Production mode now requires both `verified === true` and `complete === true`; a partial adapter cannot enable contribution. Windows Job Objects and macOS enforcement are not implemented. Do not change this safety gate to make a demo work.

## Adaptive controller and restart hysteresis

`src/adaptive-controller.js` wraps the governor with a conservative restart policy. Any disabled/zero-budget governor decision pauses work immediately and resets the healthy-sample streak. Work resumes only after the configured number of consecutive healthy decisions and the minimum interval since the last resume. `pause()` is an immediate local operator stop. This avoids rapid start/stop oscillation but does not itself enforce CPU, memory, disk, or network limits; production use still requires a complete verified OS enforcement adapter and reliable telemetry.


## Local storage quotas (v0.6.0)

The encrypted chunk store has owner-configurable limits: default 4 MiB per plaintext chunk and 1 GiB total stored bytes. It serializes writes within one process so concurrent `put` calls cannot overrun the configured quota. It rejects oversized chunks before encryption, verifies an existing content-addressed file before treating it as a duplicate, and checks the total on-disk size before writing. The quota is not an OS filesystem quota: external programs or multiple independent processes writing into the same directory can bypass the in-process serialization. Production deployments must use a dedicated directory with restrictive permissions and, where available, an OS-level disk quota.


## Storage directory hardening (v0.7.0)

The encrypted chunk store rejects a symlink as its root, rejects symlinks discovered inside the data tree during quota scans, applies restrictive root permissions where supported, and writes each new chunk through a synced private temporary file followed by an atomic no-overwrite hard link. These controls reduce path-substitution and partial-write risks, but they do not establish a cross-process quota: a single-writer service or operating-system-enforced filesystem quota is still required before treating the quota as a hard system boundary.


## Opaque replica storage quota and rerouting (v0.15.0)

`OpaqueReplicaStore` serializes quota checks and writes using a local queue plus an exclusive directory lock shared by cooperating processes. It returns `REA_CAPACITY_EXHAUSTED` rather than silently evicting someone else's data. `PeerStorageService` sends a signed `STORE_REJECTED` response carrying `CAPACITY_EXHAUSTED`, and `ReplicationCoordinator` tries another eligible failure domain after a failed first-wave placement. The fallback pool is bounded by the peers supplied to that replication round; discovery is not implemented here.

This is a strict application quota for this API, not an absolute physical-disk guarantee. Filesystem metadata, logs, temporary atomic-write files, unrelated programs, and hostile same-account processes are outside this quota. A true physical ceiling requires a dedicated storage volume or filesystem quota enforced by the OS and tested on the target platform. Sparse allocation is not universally equivalent to reserving physical disk space. No eviction policy deletes existing replicas automatically; a full node rejects new data and the coordinator may reroute it elsewhere.
