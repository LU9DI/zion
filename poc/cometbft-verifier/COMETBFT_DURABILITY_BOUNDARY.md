# CometBFT v0.38.26 durability boundary and D5 crash windows

**Status:** source audit plus deterministic crash-window tests; no runtime integration, no consensus-engine selection, no rollback defense (D6)
**Scope:** `poc/cometbft-verifier/`, pinned `github.com/cometbft/cometbft v0.38.26`
**Related:** `poc/cometbft-verifier/DURABLE_STATE_STORAGE_AND_RECOVERY_SPEC.md`, `docs/PROJECT_TRUSTED_CHECKPOINT_AND_STATE_SYNC_SPEC.md`

This document records what the pinned release actually persists, in what order, and with which durability guarantee, and what the application store in this package may therefore assume. Everything below was read from the pinned source and is exercised by tests in this package.

## 1. The three independent stores

| Store | Owner | Contents |
|---|---|---|
| Block store | CometBFT | block parts, block meta, hash index, per-height block commit, seen commit, `BlockStoreState{Base,Height}` |
| State store | CometBFT | `State` (last block height/ID, app hash, validators, consensus params), validators info, consensus params info, last `FinalizeBlock` response |
| Application store | this package (`store.go`) | `ZWB1` block records, snapshot generations, `CURRENT`, `FORMAT`, `LOCK` |

They never share a transaction, a batch, a database handle, or a sync. Nothing in this repository makes them atomic.

## 2. Decided-block call sequence

`consensus/state.go:1682 finalizeCommit(height)`:

1. `cs.blockStore.SaveBlock(block, blockParts, seenCommit)` (`consensus/state.go:1730`, also `SaveBlockWithExtendedCommit` when vote extensions are enabled).
   → `store/store.go:449 SaveBlock` → `store/store.go:516 saveBlockToBatch` → `store/store.go:601 saveStateAndWriteDB` → **`batch.WriteSync()`**.
   One batch holds parts, meta, hash index, last commit, seen commit and `BlockStoreState`, so the block is all-or-nothing and synchronized.
2. `cs.wal.WriteSync(EndHeightMessage{height})` (`consensus/state.go:1755`) — **fsync** of the consensus WAL. The source comment states that a crash before this message recovers by running `ApplyBlock` during the ABCI handshake.
3. `cs.blockExec.ApplyVerifiedBlock(stateCopy, blockID, block)` → `state/execution.go:253 applyBlock`:
   1. `proxyApp.FinalizeBlock(...)` (`state/execution.go:255`). The app receives the decided block and **MUST NOT persist** (`spec/abci/abci++_app_requirements.md:282`).
   2. `store.SaveFinalizeBlockResponse(height, resp)` (`state/execution.go:290`) → `state/store.go:508`: **`db.Set`** for the per-height response, **`db.SetSync`** for `lastABCIResponseKey`. Only the last response is guaranteed durable.
   3. `updateState(...)` — in memory only.
   4. `blockExec.Commit(...)` (`state/execution.go:321` → `:435`) → `proxyApp.Commit(...)`. The app **must persist its state before returning** (`spec/abci/abci++_app_requirements.md:292`). CometBFT performs no sync on the app's behalf and cannot verify that the app did.
   5. `store.Save(state)` (`state/execution.go:333`) → `state/store.go:189 save` → batch of validators info, consensus params info and `State` → **`batch.WriteSync()`**.
   6. Optional pruning, then `fireEvents` (`state/execution.go:351`).

### Persistence order

```
height H:  [ block store: blocks/parts/meta/seen commit/BlockStoreState ]  WRITE-SYNC   (1)
           [ consensus WAL: EndHeight{H} ]                                 FSYNC        (2)
           [ app: FinalizeBlock executed, nothing durable ]                (must not persist) (3a)
           [ state store: last FinalizeBlock response ]                     SET-SYNC (last only) (3b)
           [ app: Commit -> application state durable ]                     APP-OWNED FSYNC (3c)
           [ state store: State/validators/params ]                         WRITE-SYNC   (3d)
```

Consequences that the tests assert:

- The **block is durable before the application executes it**. A crash before (3c) always leaves a durable block that the application has not adopted.
- The application's `Commit` is the only place the app may persist, and it is *not* inside any CometBFT batch. Steps (3c) and (3d) can be separated by a crash in either order.
- Per-height `FinalizeBlock` responses are **not** durable; only the last one is.
- Because (1) uses `WriteSync` on a single batch, the block store cannot be observed half-written by a crash that respects the database's own durability contract.

## 3. Restart decision table (`consensus/replay.go`)

`Handshaker.ReplayBlocksWithContext` (`consensus/replay.go:300`) reads `store.Base()`, `store.Height()`, `state.LastBlockHeight` and the application's `Info` height/hash (`consensus/replay.go:247`), then:

| Condition | Pinned behavior |
|---|---|
| `storeHeight == 0` | `assertAppHashEqualsOneFromState` — **panics** if the app hash differs from its own state |
| `appHeight == 0 && InitialHeight < storeBase` | `sm.ErrAppBlockHeightTooLow` |
| `appHeight > 0 && appHeight < storeBase-1` | `sm.ErrAppBlockHeightTooLow` |
| `storeHeight < appHeight` | **`sm.ErrAppBlockHeightTooHigh`** — the app may never be ahead of the block store |
| `storeHeight < stateHeight` | **panic**: state ahead of the block store |
| `storeHeight > stateHeight+1` | **panic**: more than one block of divergence |
| `storeHeight == stateHeight`, app behind | `replayBlocks(..., mutateState=false)` — `sm.ExecCommitBlock` per missing block (`consensus/replay.go:462,508`) |
| `storeHeight == stateHeight+1`, `appHeight == stateHeight` | `replayBlock` with the real app (`consensus/replay.go:525`) — full `ApplyBlock` |
| `storeHeight == stateHeight+1`, `appHeight == storeHeight` | `replayBlock` with a **mock app** built from the durable `LoadLastFinalizeBlockResponse` (`consensus/replay.go:438-452`) |
| anything else | panic |

Two consequences matter for Zion's application store:

- **The application's `Info` output is a trust input to CometBFT's recovery, not a status report.** It decides which branch runs and, in the mock-app branch, is used as the app hash when the durable response lacks one.
- **Nothing rolls the application back.** If the app is ahead of the block store, CometBFT returns a typed error; if the hashes disagree at equal heights, it panics with `Did you reset CometBFT without resetting your application's data?`. An application store that silently reports a higher height than its verified evidence therefore converts a recoverable situation into a halt — which is the correct failure direction, but only if the app never reports unverified state as committed.

## 4. Crash windows reproduced in this package

`poc/cometbft-verifier/cometbft_boundary_test.go` runs the **real** `store.BlockStore`, `state.Store`, `proxy` local ABCI client and `consensus.Handshaker` against a `dbm.DB` (`durabilityModelDB`) that separates synchronized writes (`SetSync`/`DeleteSync`/`WriteSync`) from merely issued writes (`Set`/`Delete`/`Write`) and can restore the database to its last synchronized contents. Only the database durability is modelled; every write, batch and sync decision is the pinned implementation.

| Window | Durable before restart | Expected recovery | Test |
|---|---|---|---|
| W1 block only | block + WAL `EndHeight` | `storeHeight == stateHeight+1`, `appHeight == stateHeight` → real `ApplyBlock`; app adopts the block through its verified `ZWB1` record; state saved after `Commit` | `TestCaseA_BlockDurableApplicationBehind` |
| W2 app and state behind, block durable | block, state at H-1 | `replayBlocks(mutateState=false)`; every block's `AppHash` is cross-checked against the previous replay result; final hash must equal the durable `State.AppHash` | `TestCaseA_ApplicationDidNotPersistInCommit` |
| W3 app committed, state not saved | block, last `FinalizeBlock` response, app at H | mock-app replay fast-forwards the state store from the durable response; the app is **not** re-executed | `TestCaseW2_ApplicationCommittedButStateNotSaved` |
| W4 app ahead of block store | app at H+1, block store at H | `sm.ErrAppBlockHeightTooHigh`; the app store is untouched | `TestCaseB_ApplicationAheadOfBlockStore` |
| W5 app ahead, no durable block | app at H+1, empty block store | panic (`Did you reset CometBFT...`); the app store is untouched | `TestCaseB_EmptyBlockStorePanicsInsteadOfRollingBack` |

Durability-boundary evidence (`cometbft_windows_test.go`):

- `TestDurabilityBlockStoreSaveBlockIsAtomicAndSynchronized` — after `Crash()`, block body, meta and `BlockStoreState` all survive.
- `TestDurabilityStateStoreSaveIsSynchronized` — `State` survives.
- `TestDurabilityFinalizeBlockResponseOnlyLastIsSynchronized` — the last response survives, a per-height response written with `Set` does not.

## 5. Minimal reconciliation boundary

`consensus_reconciliation.go` defines the smallest interface this repository is willing to implement:

- `ConsensusDurabilityView{BlockStoreBase, BlockStoreHeight, ConsensusStateHeight, ConsensusAppHash}` — values that must come from synced store reads.
- `NewVerifiedBlockSource(load, verify)` — a source that cannot be constructed without a verification callback. The reconciler re-runs `verify` for **every** block immediately before `Store.AppendBlock`, so a `ZWB1` frame is never treated as proof of commitment on its own.
- `ReconcileApplicationState(app, view, source)` — advances the application only forwards, only through verified records, and returns one of `already-synced`, `replayed`, `block-store-ahead`.

Failure classification (deliberately not merged):

| Situation | Class | Error |
|---|---|---|
| App behind, evidence verified | recoverable lag | none; `replayed` |
| App behind, evidence missing/unverifiable | recoverable only with more evidence | `ErrMissingVerifiedBlock` |
| App behind a pruned block store | not locally recoverable | `ErrMissingVerifiedBlock` |
| App ahead of the block store | irreconcilable locally | `ErrAppAheadOfConsensus` |
| App and consensus state at the same height with different app hashes | irreconcilable locally | `ErrReconciliationConflict` |
| Consensus state ahead of the block store | irreconcilable (pinned release panics) | `ErrConsensusStateAheadOfBlockStore` |
| Block store more than one ahead of the state | irreconcilable (pinned release panics) | `ErrConsensusHistoryGap` |

`ReconcileApplicationState` never rewinds, never deletes a generation, never reinterprets a snapshot as consensus evidence, and never advances on a block whose replay does not reproduce the recorded post-block app hash (that check lives in `Store.AppendBlock`).

## 6. What this does not establish

- **Not atomicity.** Three stores, three syncs; a crash between any two is a real window.
- **No rollback defense (D6).** A coordinated rewrite of block store, state store, application store and a matching `CURRENT` generation is undetectable without an external authenticated monotonic reference.
- **No proof that `Commit` persisted.** The pinned spec requires it; CometBFT cannot verify it, and this package's `Store.AppendBlock` fsyncs before returning, but a different application could not.
- **The mock-app branch trusts the state store's last `FinalizeBlock` response** for the app hash. If that response is corrupt, nothing in the loop detects it beyond the checksum-free protobuf decode; this package does not consume that branch, and documents it rather than relying on it.
- **Pruning is modelled only as `BlockStoreBase`.** This package does not prune and does not implement state sync.
- **`WriteSync` means "the database says it synchronized".** Any backend or filesystem that violates that contract invalidates the whole table; the pinned release's guarantee is only as strong as the chosen `dbm.DB`.
- **No consensus engine, validator policy, genesis ceremony, DKG, gossip or admission behavior is selected or implemented here.** The three product decisions in `ZION_WIDE_ADMISSION_CONSENSUS_OPTIONS.md` §4.3 remain open, and no code in this increment depends on them.
- **The application store remains a PoC.** It is not wired into any runtime path.
