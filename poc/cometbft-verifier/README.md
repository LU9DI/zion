# Test-only CometBFT commit verifier and state replay model

This directory contains a disposable verification/replay prototype pinned to CometBFT v0.38.26. It is not imported by Zion runtime code and must not be used to admit users, peers, validators, or invitations.

## Current components

- `verifier.go`: verifies a supplied header, ordered transaction-data root, authenticated validator-set digest, expected app hash, and full CometBFT commit signatures. `VerifyCommitEvidenceWithReplay` replays the ordered transactions from a caller-supplied initial state and compares the computed app hash before accepting the commit evidence. Untrusted commit signature vectors and caller-supplied validator sets are bounded by the pinned release's `MaxVotesCount` before any per-entry validation, hashing, or protobuf conversion, in both the current-height and the next-height anchor paths.
- `state_machine.go`: decodes a bounded canonical binary transaction envelope, deterministically replays PUT/DELETE operations against an in-memory project-scoped state, and encodes/decodes bounded canonical snapshots with checksum, app-hash, project, and genesis checks.
- `wal_codec.go`: encodes and strictly decodes bounded canonical `ZWL1` v1 records, preserves the complete CometBFT block ID (block hash and part-set header), computes validated record digests, and checks adjacent hash-chain continuity.
- `block_wal_codec.go`: encodes and strictly decodes the block-atomic `ZWB1` v1 envelope required before filesystem persistence. One record carries the complete committed block identity (chain ID, height, full BlockID), every exact ordered transaction byte string, the canonical data hash recomputed with the pinned library from those bytes, the expected post-block application hash, and a commit-evidence reference digest. It rejects transaction-count/list mismatch, data-hash mismatch, reordering under a valid checksum, gap or regression between adjacent heights, and every bounded-field violation. It is still codec-only: no file, no fsync, no recovery.
- `store.go`, `store_lock_*.go`: an experimental single-process durable store: length-framed WAL segments holding `ZWB1` block records, fsync-before-adopt ordering, snapshot generation publication through temporary-file + rename + directory sync, a manifest that binds snapshot digest/block identity/app hash/WAL record digest, and recovery that verifies the whole local record chain before replaying.
- `*_test.go`: adversarial verifier, state-machine, snapshot, WAL codec and store tests, including canonical decoder fuzz targets, torn-tail and corruption injection, publish-window fault injection, and process-level crash tests.

Run from this directory:

```sh
go test -race -count=1 ./...
go vet ./...
```

The store tests write to temporary directories, spawn a subprocess for the crash cases, and re-open stores repeatedly. They do real `fsync` calls, so they are I/O bound rather than CPU bound.

## State replay model

The v1 envelope is length-delimited and rejects unknown operations, wrong project scope, malformed lengths, trailing bytes, and invalid DELETE payloads. A successful mutation advances the sequence once and records the operation ID plus transaction digest. An identical retry returns the prior result without changing state; reusing an ID with different bytes is rejected. Rejections do not mutate state or consume an operation ID.

The app hash is SHA-256 over domain-separated canonical bytes, including schema version, project ID, genesis digest, sequence, sorted key/value entries, and sorted idempotency records.

## Durable storage and recovery

[`DURABLE_STATE_STORAGE_AND_RECOVERY_SPEC.md`](./DURABLE_STATE_STORAGE_AND_RECOVERY_SPEC.md) defines the WAL/snapshot/commit-evidence separation, fsync and generation-publication ordering, crash-recovery states, CometBFT block-store reconciliation boundary, cross-platform locking requirements, rollback threat model, adversarial test matrix, and staged implementation gates.

`store.go` implements the D2 single-process durable store for the PoC application state only:

- **Ordering.** A block is replayed against a disposable copy of the current state, the resulting app hash must equal the recorded post-block app hash, the block-atomic `ZWB1` frame is appended to a length-framed WAL segment and `fsync`ed, and only then does the transition become current. `AppendBlock` never reports success before the append is durable.
- **Atomic publication.** A state snapshot is written to a synced temporary file and published by rename, then its manifest, then `CURRENT`. Recovery only ever observes a complete generation; orphaned snapshots and manifests are ignored.
- **Recovery.** The whole local record chain is verified (record number, previous digest, project/genesis/chain binding, strictly consecutive heights), the published generation is checked against the WAL record it references, and only records after the generation are replayed. A final frame shorter than its declared length is a provably uncommitted suffix and is discarded; a complete frame with a bad checksum, mid-log corruption, a gap, a conflicting block at a committed height, or a WAL that ends before its published generation fails closed with a typed error and is never silently truncated.
- **Process exclusion.** The `LOCK` file is held with `flock` on POSIX and a byte-range lock on Windows, so it is released by the operating system if the process dies. The lock file is never deleted.
- **Idempotency.** Re-applying an identical already-recorded block is a no-op; a different block at the same height is a hard conflict.

Known limits of this increment, all covered by the spec and by tests:

- A process crash (no media loss) can leave a complete but unsynced final frame visible on reopen. The store never *reported* it as durable, and replaying it is safe because the block's app hash was verified before the write, but the crash window is not made atomic with any external ack.
- Directory `fsync` is skipped on Windows, where `os.File` cannot sync a directory. Rename ordering on NTFS is therefore weaker than on POSIX and is not claimed as equivalent.
- `CURRENT`+manifest+snapshot are bound to the WAL by digests, so an inconsistent rollback is detected. A coordinated rollback of every local file is not detectable without an external authenticated monotonic reference (spec §10).
- Nothing here reconciles with CometBFT's block store, verifies commit evidence, or authenticates the writer. The caller must supply an already verified block and its evidence reference digest.

## Explicit limitations

- The snapshot codecs and the `ZWL1` codec are serialization/recovery logic only. `ZWB1` and `store.go` add local persistence, fsync ordering and crash recovery for this PoC application state, but nothing is atomically coupled to CometBFT's block store. Checksums detect accidental corruption; they are not authenticity proofs or rollback protection.
- This is a replay model, not an ABCI++ application and not a running consensus network.
- The caller must supply an independently authenticated genesis digest and validator-set hash.
- Replay verification requires the caller to supply the correct, independently authenticated initial project state/genesis. Snapshot decoding checks caller-supplied project/genesis expectations, but does not authenticate those expectations or protect against rollback to an older valid snapshot.
- The operation-result index stores successful mutations only. The product/state-machine policy for idempotency of committed rejected commands remains open.
- No user invitation, global founder ordinal, project governance, validator rotation, or production runtime behavior is implemented.

Passing these tests proves only the behavior exercised by this isolated package. It does not establish production consensus safety, authenticated bootstrap, independent validator operators, rollback resistance, or readiness to deploy.
