# Rust storage lock design proposal

**Status:** proposed design; not implemented or approved for production use  
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
