# Test-only CometBFT commit verifier and state replay model

This directory contains a disposable verification/replay prototype pinned to CometBFT v0.38.26. It is not imported by Zion runtime code and must not be used to admit users, peers, validators, or invitations.

## Current components

- `verifier.go`: verifies a supplied header, ordered transaction-data root, authenticated validator-set digest, expected app hash, and full CometBFT commit signatures. `VerifyCommitEvidenceWithReplay` replays the ordered transactions from a caller-supplied initial state and compares the computed app hash before accepting the commit evidence.
- `state_machine.go`: decodes a bounded canonical binary transaction envelope and deterministically replays PUT/DELETE operations against an in-memory project-scoped state.
- `*_test.go`: adversarial verifier and state-machine tests.

Run from this directory:

```sh
go test -race -count=1 ./...
go vet ./...
```

## State replay model

The v1 envelope is length-delimited and rejects unknown operations, wrong project scope, malformed lengths, trailing bytes, and invalid DELETE payloads. A successful mutation advances the sequence once and records the operation ID plus transaction digest. An identical retry returns the prior result without changing state; reusing an ID with different bytes is rejected. Rejections do not mutate state or consume an operation ID.

The app hash is SHA-256 over domain-separated canonical bytes, including schema version, project ID, genesis digest, sequence, sorted key/value entries, and sorted idempotency records.

## Explicit limitations

- In-memory only: no persistence, fsync, snapshot, WAL, crash recovery, or atomic coupling to CometBFT's block store.
- This is a replay model, not an ABCI++ application and not a running consensus network.
- The caller must supply an independently authenticated genesis digest and validator-set hash.
- Replay verification requires the caller to supply the correct, independently authenticated initial project state/genesis. The helper verifies the replayed app hash against the signed header but does not authenticate the genesis or validator set on its own.
- The operation-result index stores successful mutations only. The product/state-machine policy for idempotency of committed rejected commands remains open.
- No user invitation, global founder ordinal, project governance, validator rotation, or production runtime behavior is implemented.

Passing these tests proves only the behavior exercised by this isolated package. It does not establish production consensus safety, authenticated bootstrap, independent validator operators, rollback resistance, or readiness to deploy.
