# Node identity bootstrap and crash-recovery protocol

Status: **design gate; not implemented**

Scope: PR #68, branch `architecture/fully-decentralized-core`

## Security invariants

1. A node has exactly one active Ed25519 identity for a given local identity slot.
2. Once an identity record is published, startup must never silently generate a replacement identity.
3. A wrapping key is immutable for its key ID. A provisioning operation must not overwrite an existing key.
4. A node must fail closed if the OS keystore is unavailable, locked, ambiguous, or inconsistent with the identity record.
5. No plaintext private key, plaintext DEK, environment-variable master key, hosted key escrow, or central recovery service is permitted.
6. Identity recovery is an explicit operation with verifiable authorization; it is never an automatic response to a missing file or credential.

## Local state machine

- `ABSENT`: no published identity record and no committed key metadata.
- `PROVISIONING`: one process owns the exclusive initialization gate; no second process may initialize or start this identity slot.
- `PUBLISHED`: encrypted identity record and matching OS-keystore wrapping key have both been verified and durably published.
- `RECOVERY_REQUIRED`: interrupted or inconsistent state; ordinary startup is blocked until an explicit recovery procedure resolves it.

Allowed transitions:

- `ABSENT -> PROVISIONING -> PUBLISHED`
- `PROVISIONING -> RECOVERY_REQUIRED` after an ambiguous failure or interrupted operation
- `PUBLISHED -> RECOVERY_REQUIRED` if the record, keystore credential, permissions, or identity binding cannot be verified
- Explicit operator recovery may return `RECOVERY_REQUIRED -> PUBLISHED` only after cryptographic and authorization checks.

There is no automatic `RECOVERY_REQUIRED -> ABSENT` transition and no automatic identity regeneration.

## Initialization transaction

The production implementation must perform these operations under a kernel-enforced, cross-process exclusive gate scoped to the identity slot:

1. Resolve the per-user state directory and verify every path component. Reject symlinks/reparse points, unexpected ownership, unsafe ACLs, and non-directory components.
2. Acquire the exclusive gate. An in-process mutex is insufficient.
3. Re-check that no published identity record or wrapping credential exists. If either exists, stop and enter recovery/verification; do not overwrite.
4. Create a random Ed25519 identity and random wrapping key. Provision the wrapping key in the OS keystore using a no-overwrite protocol.
5. Read the credential back and verify it matches the just-created key. If the result is ambiguous, do not publish the identity record.
6. Create the encrypted identity record in a same-directory temporary file using exclusive creation and restrictive permissions.
7. Flush the file, atomically publish it without replacing an existing record, then flush the containing directory where supported.
8. Re-open the published record, restore the identity through the keystore, and verify the node ID and public key.
9. Release the gate only after all checks pass.

The implementation must document the durability guarantees and platform differences for Windows and Linux. Atomic rename alone is not sufficient if it can replace an existing destination or if the containing directory is not durably synchronized.

## Crash and restart behavior

| Interruption point | Required behavior |
|---|---|
| Before gate acquisition | Another process may proceed normally |
| After gate acquisition, before keystore write | Fail closed; recover gate only after proving initializer is no longer active |
| During/after keystore write, before read-back | Treat credential state as ambiguous; never overwrite automatically |
| After key read-back, before record publication | Enter recovery; do not generate a second key under the same identity slot |
| During temporary record write | Ignore no artifact silently; validate and quarantine/remove only under explicit recovery |
| After record publication, before directory durability confirmation | Enter recovery and verify both record and credential |
| After durable publication | Restart must restore exactly the same node ID and signing identity |

Automatic stale-gate stealing is prohibited until process ownership, process lifetime, PID reuse, and TOCTOU behavior are proven on each supported platform. The initial implementation may fail closed and require manual recovery from an abandoned gate; availability is subordinate to identity integrity.

## Multi-process startup

- Every official node startup must acquire a shared/exclusive lifecycle gate or otherwise prove that no initializer/rotation operation is active.
- Only one process may provision or rotate an identity slot at a time.
- Normal readers may not observe a partially published record.
- A second initializer must observe the first initializer's committed result or fail closed. It must never replace the wrapping key or publish a competing identity.
- Tests must use separate OS processes, not only Promise concurrency or worker threads.

## Backup, migration, and recovery

The OS credential store is machine/user scoped and is not itself a portable backup.

- Back up the encrypted identity record separately from the local wrapping credential.
- Do not export or copy the OS wrapping key as part of an ordinary filesystem backup.
- Machine migration requires an explicit recovery ceremony. Candidate designs include a user-held encrypted recovery package or a project-governance-authorized threshold recovery; neither is implemented or selected here.
- No cloud escrow, central CA, hosted identity service, or mandatory recovery server may be introduced.
- Loss of both the local keystore credential and all approved recovery material is an identity-loss event. Do not silently mint a replacement node ID and pretend continuity.

## Required tests before launcher integration

- Independent-process simultaneous first initialization.
- Process termination at every transaction boundary above.
- Restart after successful publication with identical node ID and successful signature verification.
- Tampered record, wrong keystore credential, missing/locked credential store, and key ID collision.
- Symlink/reparse-point substitution, unsafe permissions/ACLs, pre-existing destination, and directory replacement.
- Concurrent startup versus initialization and concurrent rotation.
- Backup restore and machine migration through the selected explicit recovery ceremony.
- Windows and Linux CI with real OS-backed keystore services. Fake adapters remain unit-test-only.

## Non-goals and current status

This document is a protocol proposal, not implementation evidence. It does not make the existing launcher safe, does not add an OS keystore dependency, and does not authorize production mode. The current encrypted identity-record module remains a cryptographic core only. Filesystem persistence, platform keystore adapters, lifecycle locking, backup/recovery, and launcher integration remain blocked on the tests above.
