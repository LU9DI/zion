# Test-only CometBFT commit verifier and state replay model

This directory contains a disposable verification/replay prototype pinned to CometBFT v0.38.26. It is not imported by Zion runtime code and must not be used to admit users, peers, validators, or invitations.

## Current components

- `verifier.go`: verifies a supplied header, ordered transaction-data root, authenticated validator-set digest, expected app hash, and full CometBFT commit signatures. `VerifyCommitEvidenceWithReplay` replays the ordered transactions from a caller-supplied initial state and compares the computed app hash before accepting the commit evidence. Untrusted commit signature vectors and caller-supplied validator sets are bounded by the pinned release's `MaxVotesCount` before any per-entry validation, hashing, or protobuf conversion, in both the current-height and the next-height anchor paths.
- `state_machine.go`: decodes a bounded canonical binary transaction envelope, deterministically replays PUT/DELETE operations against an in-memory project-scoped state, and encodes/decodes bounded canonical snapshots with checksum, app-hash, project, and genesis checks.
- `wal_codec.go`: encodes and strictly decodes bounded canonical `ZWL1` v1 records, preserves the complete CometBFT block ID (block hash and part-set header), computes validated record digests, and checks adjacent hash-chain continuity.
- `*_test.go`: adversarial verifier, state-machine, snapshot, and WAL codec tests, including a canonical decoder fuzz target.

Run from this directory:

```sh
go test -race -count=1 ./...
go vet ./...
```

## State replay model

The v1 envelope is length-delimited and rejects unknown operations, wrong project scope, malformed lengths, trailing bytes, and invalid DELETE payloads. A successful mutation advances the sequence once and records the operation ID plus transaction digest. An identical retry returns the prior result without changing state; reusing an ID with different bytes is rejected. Rejections do not mutate state or consume an operation ID.

The app hash is SHA-256 over domain-separated canonical bytes, including schema version, project ID, genesis digest, sequence, sorted key/value entries, and sorted idempotency records.

## Durable storage and recovery

[`DURABLE_STATE_STORAGE_AND_RECOVERY_SPEC.md`](./DURABLE_STATE_STORAGE_AND_RECOVERY_SPEC.md) defines the proposed WAL/snapshot/commit-evidence separation, fsync and generation-publication ordering, crash-recovery states, CometBFT block-store reconciliation boundary, cross-platform locking requirements, rollback threat model, adversarial test matrix, and staged implementation gates.

The D1 WAL codec, canonical golden vector, adversarial tests, and decoder fuzz target remain codec-only. The verifier now distinguishes Header(H).AppHash (pre-block state) from the replayed post-block state and authenticates the latter through a signed H+1 anchor, including the H+1 LastCommitHash link to the H commit. On PR head `d3d0796c0150a0329172f17ef95db69f2105dc4a`, the complete Zion validation workflow and CodeQL security analysis both reached terminal `success`; the dedicated CometBFT verifier job passed `go test -race -count=1 ./...` and `go vet ./...`. These results validate the current test scope only. D2 remains blocked by the block-atomic WAL design, authenticated genesis/InitChain and validator-set bootstrap, and the full ABCI++ persistence/recovery model. ZWL1 remains a pure codec experiment: no filesystem persistence, fsync, WAL append, crash recovery, or runtime integration is implemented or claimed.

## Explicit limitations

- The snapshot codec is serialization/recovery logic only. The WAL codec is serialization and local chain-validation logic only: neither provides filesystem persistence, fsync, crash recovery, or atomic coupling to CometBFT's block store. Checksums detect accidental corruption; they are not authenticity proofs or rollback protection.
- This is a replay model, not an ABCI++ application and not a running consensus network.
- The caller must supply an independently authenticated genesis digest and validator-set hash.
- Replay verification requires the caller to supply the correct, independently authenticated initial project state/genesis. Snapshot decoding checks caller-supplied project/genesis expectations, but does not authenticate those expectations or protect against rollback to an older valid snapshot.
- The operation-result index stores successful mutations only. The product/state-machine policy for idempotency of committed rejected commands remains open.
- No user invitation, global founder ordinal, project governance, validator rotation, or production runtime behavior is implemented.

Passing these tests proves only the behavior exercised by this isolated package. It does not establish production consensus safety, authenticated bootstrap, independent validator operators, rollback resistance, or readiness to deploy.
