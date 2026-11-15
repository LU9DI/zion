# CometBFT v0.38.26 ABCI++ commit/finality contract audit

**Status:** source/API audit only; no Zion runtime integration or consensus-engine dependency added  
**Scope:** PR #68, branch `architecture/fully-decentralized-core`  
**Audited upstream version:** CometBFT tag `v0.38.26`  
**Date:** 2026-11-15

## 1. Executive findings

The upstream v0.38.26 source confirms an important separation that Zion must preserve:

1. CometBFT consensus decides a block after more than two-thirds of the validator voting power precommits the same block ID.
2. The CometBFT node persists the decided block and its commit evidence, then calls the ABCI application to execute the decided block through `FinalizeBlock`.
3. The application returns deterministic transaction results, validator/consensus-parameter updates, and the application state hash from `FinalizeBlock`.
4. The application durably persists its corresponding state in `Commit`; `Commit` does not return a quorum certificate or a commit hash.
5. An external verifier that needs independently verifiable finality must verify CometBFT's signed header/commit against the appropriate validator set and trusted header chain. A successful local ABCI callback, local database write, application ACK, or transaction response is not itself a portable proof of BFT finality.

This is compatible with the architectural separation in Zion's existing contract: deterministic application execution is not the consensus engine, and application persistence is not the commit certificate.

## 2. Exact upstream API facts

The following facts were checked against the exact `v0.38.26` tag, not inferred from a later main-branch document.

### 2.1 `FinalizeBlock` computes the deterministic application result

The ABCI++ `FinalizeBlock` request contains the decided block's transactions, the *previous* commit information (`decided_last_commit`), misbehavior evidence, block hash, height, time, next validator hash, and proposer address.

Its response contains:
- transaction execution results;
- validator-set updates;
- consensus-parameter updates;
- events; and
- `app_hash`, the application-state Merkle root.

The `app_hash` is deterministic and is returned by `FinalizeBlock`, not by the `Commit` response. The application must execute the decided transactions deterministically. `ProcessProposal` must also be deterministic and depend only on the proposed block and the last committed application state. Proposal processing can occur multiple times for different rounds/blocks, and candidate state from a proposal must not replace committed state unless that block is the one finalized.

**Zion implication:** all consensus-critical invitation/membership/founder state transitions must be deterministic functions of the prior committed state and ordered command bytes. No local clock, local randomness, filesystem state, network lookup, environment value, or per-node operational observation may affect their result. Any pre-execution of proposals must be isolated as disposable candidate state.

### 2.2 `Commit` persists application state; it does not issue a commit certificate

The v0.38.26 ABCI method definition describes `Commit` as a parameterless request instructing the application to persist its state. The `ResponseCommit` protobuf contains only `retain_height`.

The generated `Application` interface in `abci/types/application.go` has a stale/misleading comment saying that `Commit` returns the application Merkle root hash. The actual v0.38.26 protobuf response and method specification do not contain an app-hash field in `ResponseCommit`; the hash is returned by `FinalizeBlock`. Integrators must follow the actual request/response schema and versioned specification, not that interface comment.

**Zion implication:** do not design an adapter that expects an application-level `Commit` response to contain a quorum certificate, a validator signature set, or the application hash. The app's job at this boundary is durable state persistence and recovery bookkeeping.

### 2.3 Consensus decision and block evidence are in CometBFT, not in the ABCI app callback

In `consensus/state.go`, `tryFinalizeCommit` looks for a two-thirds majority of precommits for a non-empty block ID. `finalizeCommit` checks the proposal block against that ID, validates the block, saves the block together with the observed commit evidence, and invokes block execution.

In `types/block.go`, `Commit` is explicitly described as evidence that a block was committed by a set of validators. `types/validator_set.go` exposes `VerifyCommit` and light-client verification methods that verify the required voting power and signatures. `light/verifier.go` verifies signed headers and validator-set transitions, including adjacent and non-adjacent trusted-header cases.

The ABCI `FinalizeBlock` request does not contain the current block's commit certificate. Its `decided_last_commit` field refers to the previous block. The current decision is made by CometBFT's consensus engine before the callback.

**Zion implication:** if Zion nodes, wallets, or clients must independently establish that an admission transition is final, the protocol must define how they obtain and verify a signed header/commit plus the relevant validator-set and trust-transition evidence. They must not accept a web/API server's statement that its local ABCI `FinalizeBlock` or `Commit` callback succeeded as proof of global finality.

## 3. Crash recovery and persistence ordering

The v0.38.26 application requirements describe three persistence milestones for a height:

1. CometBFT stores the block in its block store.
2. CometBFT stores the state/results returned by `FinalizeBlock`.
3. The application persists its state during `Commit`.

These writes are not one atomic cross-component transaction. The documented recovery behavior replays `FinalizeBlock` when the block exists but the application has not completed `Commit`; if CometBFT has stored the finalize results but the application has not persisted, the application is re-executed and the results are compared. CometBFT expects the application not to report a persisted height ahead of its own persisted state.

**Zion requirements before integration:**
- Persist application state, committed height, state root, operation-result/idempotency records, invitation consumption, membership mutation, and founder ordinal under one application-level atomic durability boundary.
- Make replay of the same finalized block deterministic and safe. A crash between the engine's state persistence and application persistence must not duplicate external effects or issue a second admission.
- Expose `Info` values that exactly match the last successfully committed application height and the corresponding `FinalizeBlock` app hash.
- Never advance application committed height beyond the height CometBFT has durably stored.
- Keep notification/email/UI/network side effects out of `FinalizeBlock` and `Commit`. Persist an outbox item as part of the deterministic state transition and deliver it after commit with idempotent effect IDs.
- Do not call synchronous mempool broadcast operations from the sequential `Commit` path; the upstream requirements warn that this can deadlock because CometBFT holds the mempool lock while invoking `Commit`.

This audit does not claim that a single application database transaction can make CometBFT's block store and the application's own store physically atomic. The documented replay/handshake contract must be implemented and fault-tested instead.

## 4. Admission protocol implications

For Zion's future invitation protocol, the canonical admission transaction should produce, in the same deterministic finalized transition:
- invitation state change (consumed/revoked/issued as applicable);
- recipient membership state change;
- founder ordinal assignment, if the global cohort has not reached 1,000;
- operation ID and immutable terminal result;
- the new application state root.

A client timeout after submission remains an unknown outcome until the client queries the same operation ID or verifies the resulting committed state. It must not create a new redemption operation automatically.

The application state machine can guarantee deterministic single execution *within one consensus domain*. It cannot turn independent project committees into a Zion-wide ordering service. The global-versus-project admission scope blocker in `ZION_WIDE_ADMISSION_CONSENSUS_OPTIONS.md` therefore remains unchanged.

The network must fail closed when it cannot verify the relevant admission domain's commit. A local application process that is ahead, stale, replaying, or unable to establish the required commit state must not issue an admission success response.

## 5. Boundaries and non-claims

This audit:
- does not select CometBFT for Zion;
- does not prove the project's current runtime uses CometBFT;
- does not add a Go module, dependency, ABCI server, validator set, genesis file, or runtime adapter;
- does not define admission-domain bootstrap trust, validator independence, quorum governance, key rotation, or Sybil resistance;
- does not prove that any Zion application store currently satisfies CometBFT's recovery contract;
- does not authorize implementation of a global admission committee, merge, deployment, release, or production migration.

The Zion repository's root has no `go.mod` and its root `Cargo.toml` only defines the Rust workspace. This is a documentation/source audit of the upstream version named by the existing design work, not evidence of an integrated or pinned CometBFT runtime dependency.

## 6. Upstream source references (tag `v0.38.26`)

- [ABCI++ application requirements](https://github.com/cometbft/cometbft/blob/v0.38.26/spec/abci/abci%2B%2B_app_requirements.md)
- [ABCI++ method definitions](https://github.com/cometbft/cometbft/blob/v0.38.26/spec/abci/abci%2B%2B_methods.md)
- [ABCI++ basic concepts](https://github.com/cometbft/cometbft/blob/v0.38.26/spec/abci/abci%2B%2B_basic_concepts.md)
- [Application interface](https://github.com/cometbft/cometbft/blob/v0.38.26/abci/types/application.go)
- [ABCI protobuf types](https://github.com/cometbft/cometbft/blob/v0.38.26/abci/types/types.pb.go)
- [Consensus finalization path](https://github.com/cometbft/cometbft/blob/v0.38.26/consensus/state.go)
- [Block and commit types](https://github.com/cometbft/cometbft/blob/v0.38.26/types/block.go)
- [Validator-set commit verification](https://github.com/cometbft/cometbft/blob/v0.38.26/types/validator_set.go)
- [Light-client verification](https://github.com/cometbft/cometbft/blob/v0.38.26/light/verifier.go)

## 7. Required next design work

Before any adapter code is written, a separate design must specify:
1. the exact CometBFT version and whether the project is actually adopting it;
2. the application storage engine and crash/replay state machine;
3. how clients verify signed headers and validator-set transitions from an authenticated trust root;
4. how admission commands, idempotency results, and outbox records are encoded and bounded;
5. deterministic rejection, retry, and ambiguous-outcome semantics;
6. fault-injection coverage at every persistence milestone;
7. validator bootstrap, membership, quorum, rotation, and recovery assumptions.

Until then, project BFT and global admission implementation remain blocked at their existing design gates.
