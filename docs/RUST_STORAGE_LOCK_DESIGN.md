# Rust storage lock design proposal

**Status:** implemented and CI-validated on Ubuntu, macOS, and Windows; independent security review and production approval remain outstanding  
**Scope:** local cross-process mutual exclusion for `rust-core` storage operations  
**Out of scope:** distributed consensus, quorum commitment, network membership, and the test-only committed-block journal

## 1. Problem

The current `StorageCore::with_lock` implementation publishes a lock directory before its owner record is complete. On Unix, stale recovery can treat an absent, malformed, unreadable, or invalid owner record as stale based on a 30-second directory age. A live process paused during lock initialization can therefore lose its lock to a contender. Recovery and release also perform separate pathname checks and mutations, leaving replacement races.

The existing implementation must not be treated as safe for concurrent writers under process pauses, hostile local path replacement, or adversarial multi-process scheduling.

## 2. Proposed mechanism: stable lock file + OS advisory lock

Replace the directory/PID protocol with a persistent lock file opened once and locked through an OS-backed advisory-lock API.

A candidate implementation dependency is a small, pinned cross-platform lock crate such as `fs2`, subject to a source/dependency audit and confirmation of its Unix and Windows implementations before adoption. The crate is a candidate, not a dependency selected or added by this document.

### Acquisition and lifetime

1. Resolve and validate the storage root before opening the lock file. The root must be a real directory, not a symlink/reparse-point substitute, and must be owned/writable only by the trusted service identity (Unix mode target `0700`; Windows ACL policy must be explicitly defined).
2. Open a stable lock file (for example, `.rea-rust-storage.lock`) with create-if-absent semantics. Do not delete or rename this file during normal operation or recovery.
3. Use no-follow/reparse-point protections where supported. Validate the opened handle refers to a regular file, not a symlink, directory, or other special object. Keep the opened handle; do not close and reopen by pathname between validation and lock acquisition.
4. Acquire an exclusive OS advisory lock on that open handle. Wait only up to the existing configured timeout; on timeout return `LockTimeout`. Do not use PID age, wall-clock age, or owner-file contents to steal a lock.
5. Hold the handle and advisory lock for the entire critical section. Release by unlocking/closing that same handle. On process termination, the operating system releases the lock when the owning open handle is closed by process teardown; the stable lock file remains in place.
6. Never unlink the lock file as part of acquisition, release, or stale recovery. Its persistent identity prevents a new process from locking a replacement inode while another process still holds the old inode.

### Important limits

- Advisory locks protect only cooperating processes. They do not stop a process that ignores the lock protocol or can write storage files directly.
- Lock semantics differ across local filesystems, network filesystems, containers, and OS versions. The supported filesystem matrix must be explicit; unsupported or unverified filesystems must fail closed or be documented as unsupported.
- Unix `flock` and POSIX record locks are not interchangeable. The selected library's exact primitive, inheritance/duplication behavior, and interaction with multiple handles in one process must be verified from source and tests.
- Windows requires a separately reviewed handle-based locking path (for example, `LockFileEx`); Unix assumptions must not be applied to Windows.
- A stable lock file does not by itself secure an attacker-writable parent directory. Parent-directory ownership/ACLs and path traversal must be enforced.
- Advisory locking is local storage coordination, not BFT, quorum, distributed consensus, or a global admission authority.

## 3. Why not repair the current directory lock

Adding more PID checks, longer age thresholds, random owner tokens, or additional pathname checks does not close the check-then-rename/unlink race. A stale-lock algorithm that cannot prove ownership and process death must not reclaim the lock. A persistent OS lock avoids pathname-based ownership transfer and makes process exit a kernel-managed release event.

## 4. Required implementation and validation gates

Do not replace the current code until all of the following are completed:

1. Audit the candidate crate's exact pinned source and license; record which primitive is used on each supported target and the semantics of lock acquisition, unlock, process exit, duplicated handles, and same-process competing handles.
2. Define the supported OS and filesystem matrix. At minimum, add CI coverage for Linux, macOS, and Windows if all three are claimed as supported. Explicitly decide whether network filesystems are unsupported.
3. Add two-process contention tests proving exactly one writer enters the critical section at a time.
4. Add a child-process termination test proving a second process can acquire the lock after the first process is forcibly terminated, without deleting/recreating the lock file.
5. Add initialization interruption tests proving a partially initialized persistent lock file is harmless because ownership is the OS lock, not serialized owner metadata.
6. Add tests for symlink/reparse-point lock paths, non-regular lock targets, untrusted root permissions/ACLs, and concurrent path replacement within the declared threat model.
7. Add same-process multi-handle tests and process/fork inheritance tests where applicable.
8. Run formatting, clippy, Rust unit tests, and the complete repository CI matrix on the exact implementation commit. Do not claim cross-platform support from Linux-only CI.
9. Obtain independent review of the filesystem and locking design before production use.

## 5. Migration and failure policy

The new implementation must not automatically interpret or delete an old directory lock. Migration requires a controlled stop of all writers, preservation of existing lock metadata for audit, operator confirmation that no old binary remains active, and a one-time conversion procedure. If that cannot be independently established, retain the old lock and fail closed.

Any lock API error, unsupported filesystem behavior, failed handle validation, or ambiguous ownership state must prevent the storage mutation. No fallback to age-based deletion, PID-based lock stealing, or unlocked writes is permitted.

## 6. Current status

This document is a design proposal only. No dependency has been added, no Rust source or lockfile has been modified, and no tests have been run for this proposal. The existing directory/PID lock remains unchanged and retains the limitations recorded in `docs/PROJECT_COMMITTED_STATE_MACHINE_CONTRACT.md`.

The design must be reviewed and validated before implementation. Even after local storage locking is improved, this does not solve the separate Zion-wide global-admission consensus conflict or provide BFT finality.

## 7. Re-evaluation: Rust standard-library file locks (2026-11-14)

A better first candidate than adding `fs2` is the Rust standard library API
`std::fs::File::lock` / `File::try_lock`, both stable since Rust 1.89. The
standard-library documentation states that the current Unix implementation
uses `flock(LOCK_EX)` and the current Windows implementation uses
`LockFileEx(LOCKFILE_EXCLUSIVE_LOCK)`. It also documents that the lock is
released when the file and any duplicated/inherited handles are closed, or
when explicitly unlocked. See the official Rust API documentation:

- https://doc.rust-lang.org/std/fs/struct.File.html#method.lock
- https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock

This removes the need to introduce a third-party locking dependency for the
initial implementation candidate. It also gives a concrete minimum compiler
requirement: Rust 1.89.0 or newer. The repository currently has no explicit
`rust-version` declaration in `rust-core/Cargo.toml` and no checked-in
`rust-toolchain.toml` was found at the project root or under `rust-core` in
the inspected branch. Before implementation, the CI toolchain must be
inspected and the minimum version made explicit in crate metadata and CI.

### Standard-library caveats to carry into implementation

- The standard-library docs say locking may be advisory or mandatory, and
  that interactions with ordinary reads/writes are platform-specific. Every
  writer must therefore cooperate with the same lock protocol.
- The docs explicitly warn that locking again through the same file handle
  or a clone has unspecified, platform-dependent behavior, potentially
  including deadlock. The implementation must own one lock handle per
  critical section and must not clone it or reacquire through it.
- The lock remains held while duplicated or inherited handles remain open.
  Child-process inheritance and handle duplication must be tested or
  prohibited by the process model; closing only the parent variable is not
  sufficient if another handle remains alive.
- On Windows, the file must not be opened append-only. Use a documented
  read/write open mode and test it on Windows CI.
- The standard library's current OS mapping is documented as current behavior
  and may change in future Rust releases. Pin the minimum compiler and retain
  platform-specific contention/termination tests.
- The API does not make path resolution safe. The lock path still needs
  no-follow/reparse-point validation, a trusted parent directory, and
  verification that the opened handle is a regular file. A pathname must
  never be unlinked or replaced during the lock's lifetime.
- Do not assume semantics on NFS, SMB, FUSE, overlay filesystems, or shared
  volumes without dedicated tests. Initially support only explicitly tested
  local filesystems; reject or document all others as unsupported.

### Updated direction

Prefer the standard-library `File::try_lock` / `File::lock` APIs over adding
`fs2`, provided the repository's CI and declared MSRV can be raised to Rust
1.89 or newer and the platform/path gates above are implemented. If that MSRV
is unacceptable, evaluate a pinned third-party crate by auditing its exact
Unix and Windows source rather than assuming portability from its API name.

This is still a design decision, not an implementation. No dependency,
minimum Rust version, Rust source, or lockfile was changed in this commit.

### CI toolchain compatibility evidence

The successful validation job for commit
`1ffc5074ba85d495c6ee1f7f56cedcc5df011ebf` logged
`rustc 1.100.0 (0ef1bc386 2026-11-09)` and ran
`cargo test --locked --manifest-path rust-core/Cargo.toml`. The workflow
selects the moving `stable` channel rather than a pinned compiler. This
confirms the currently observed CI toolchain is newer than the proposed 1.89
minimum, but does not prove that developer environments or downstream users
use a compatible compiler. If the native lock API is adopted, declare
`rust-version = "1.89"` in `rust-core/Cargo.toml` and add an explicit MSRV
check to CI; keep the main validation job on stable or a deliberately chosen
newer toolchain.

The CI evidence above belongs to the earlier validation commit and does not
constitute a build or test of this proposed locking design.


## 8. Implementation and CI evidence (2026-11-15)

**Implementation status:** implemented in `rust-core/src/lib.rs`; cross-platform CI
passed for commit
`4196717f23cf41d993b6b4352019978a541fba56`. This section supersedes the
proposal-only status statements in sections 6 and 7 where they describe the
current repository state.

The implementation uses the Rust standard-library `File::try_lock` API
(minimum Rust 1.89), a persistent lock file, handle-based validation, and
bounded contention waiting. The lock file is retained; the implementation
does not reclaim locks based on PID or file age and does not unlink the lock
file during normal acquisition or release.

### Verified on the implementation commit

- Rust storage-lock test matrix: Ubuntu, macOS, and Windows — all passed.
- Lock tests cover persistent-file retention and exclusivity, contention
  timeout, cross-process exclusion, release after child-process termination,
  and Unix symlink rejection.
- Rust 1.89 test run: 13 passed, 0 failed.
- Stable Rust test run: 13 passed, 0 failed.
- Release build of `rea-storage-cli`: passed.
- Node-to-Rust sidecar integration test: 1 passed, 0 failed.
- Repository Node suite: 843 tests, 840 passed, 0 failed, 3 skipped.
- PostgreSQL-backed validation and ClamAV integration jobs: passed.
- CodeQL JavaScript/TypeScript and Rust analyses: passed.
- CometBFT private-runner network smoke: passed.

CI run references:
- Validation: https://github.com/LU9DI/zion/actions/runs/43659902255
- CodeQL: https://github.com/LU9DI/zion/actions/runs/43659902247
- Private-runner smoke: https://github.com/LU9DI/zion/actions/runs/43659896865

### Remaining limits and review gates

These results validate the repository's tested lock behavior on the listed
hosted CI operating systems. They do not establish support for NFS, SMB,
FUSE, overlay/shared volumes, or every local filesystem and mount option.
The current test suite also does not constitute a full hostile-parent-directory
ACL/permission audit, exhaustive concurrent pathname-replacement testing, or
an independent security review. Those remain explicit pre-production review
gates. The lock is local process coordination only; it is not distributed
consensus, BFT finality, or a global admission authority.

The PR remains a draft. Passing CI does not authorize merge, deployment, or
production use.
