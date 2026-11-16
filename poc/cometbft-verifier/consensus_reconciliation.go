package verifier

import (
	"bytes"
	"errors"
	"fmt"
)

// This file defines the minimal D5 reconciliation boundary between three
// independent persistence systems:
//
//   - the CometBFT block store (blocks, block meta, hash index, seen commits);
//   - the CometBFT state store (validators, consensus params, State, and the
//     last FinalizeBlock response);
//   - this package's application store (ZWB1 records, snapshots, CURRENT).
//
// They are not one atomic transaction, and nothing here makes them one. The
// pinned v0.38.26 order (see COMETBFT_DURABILITY_BOUNDARY.md) is:
//
//	blockStore.SaveBlock      -> batch.WriteSync()
//	FinalizeBlock             -> application must NOT persist
//	stateStore.SaveFinalizeBlockResponse -> db.SetSync(last response)
//	Commit                    -> application MUST persist before returning
//	stateStore.Save(state)    -> batch.WriteSync()
//
// so the only crash windows that can exist have the block durable first. The
// application can be behind the block store (recoverable by verified replay) but
// must never be ahead of it: v0.38.26 returns sm.ErrAppBlockHeightTooHigh and
// panics when the app's Info hash disagrees with its own durable state.
//
// The reconciliation API therefore cannot advance state from local data. It
// needs a VerifiedBlockSource, which is only constructible together with an
// evidence-verification callback, and it re-runs that callback for every block
// before the application store is allowed to adopt it.

var (
	// ErrAppAheadOfConsensus: the application store is at a higher height than
	// the durable CometBFT block store. Per the pinned spec this is under the
	// application's control and is never silently repaired here.
	ErrAppAheadOfConsensus = errors.New("application store is ahead of the durable block store")
	// ErrConsensusStateAheadOfBlockStore: CometBFT's state store claims a height
	// above the block store. v0.38.26 panics on this; it is not recoverable here.
	ErrConsensusStateAheadOfBlockStore = errors.New("consensus state is ahead of the block store")
	// ErrConsensusHistoryGap: the store is more than one block ahead of the
	// consensus state, which the pinned release treats as impossible.
	ErrConsensusHistoryGap = errors.New("block store is more than one block ahead of the consensus state")
	// ErrReconciliationConflict: local stores disagree at the same height.
	ErrReconciliationConflict = errors.New("local stores disagree at the same height")
	// ErrMissingVerifiedBlock: the block needed to advance is unavailable, or its
	// commit evidence could not be verified.
	ErrMissingVerifiedBlock = errors.New("no verified block available for the required height")
)

// VerifiedBlockSource supplies the block-atomic record for one height. A record
// is only acceptable after VerifyCommitEvidenceWithReplay has authenticated the
// signed header, the ordered transaction bytes, the full commit certificate, and
// the H+1 post-state anchor against an authenticated validator set. A ZWB1 frame
// on its own is not evidence of consensus commitment.
type verifiedBlockSource struct {
	load   func(height uint64) (WALBlockRecord, error)
	verify func(record WALBlockRecord) error
}

// NewVerifiedBlockSource builds the only source the reconciler accepts. The
// verification callback is mandatory: construction fails without it so a caller
// cannot reconcile by loading bytes it never authenticated.
func NewVerifiedBlockSource(
	load func(height uint64) (WALBlockRecord, error),
	verify func(record WALBlockRecord) error,
) (*verifiedBlockSource, error) {
	if load == nil || verify == nil {
		return nil, fmt.Errorf("%w: load and verify callbacks are both required", ErrMissingVerifiedBlock)
	}
	return &verifiedBlockSource{load: load, verify: verify}, nil
}

// VerifiedBlock loads and re-verifies one height.
func (s *verifiedBlockSource) VerifiedBlock(height uint64) (WALBlockRecord, error) {
	if s == nil || s.load == nil || s.verify == nil {
		return WALBlockRecord{}, ErrMissingVerifiedBlock
	}
	record, err := s.load(height)
	if err != nil {
		return WALBlockRecord{}, fmt.Errorf("%w: height %d: %v", ErrMissingVerifiedBlock, height, err)
	}
	if record.Height != height {
		return WALBlockRecord{}, fmt.Errorf("%w: requested height %d, source returned %d",
			ErrMissingVerifiedBlock, height, record.Height)
	}
	if err := s.verify(record); err != nil {
		return WALBlockRecord{}, fmt.Errorf("%w: height %d: %v", ErrMissingVerifiedBlock, height, err)
	}
	return record, nil
}

// ConsensusDurabilityView is what the caller could establish about the two
// CometBFT stores from their durable contents. Every field must come from a
// synced store read, not from an in-memory consensus object, an RPC response
// from a peer, or an unverified local cache.
type ConsensusDurabilityView struct {
	// BlockStoreBase is block store base height (pruned blocks below it).
	BlockStoreBase int64
	// BlockStoreHeight is the highest durably stored block height.
	BlockStoreHeight int64
	// ConsensusStateHeight is the state store's LastBlockHeight.
	ConsensusStateHeight int64
	// ConsensusAppHash is the state store's AppHash at ConsensusStateHeight.
	// It is compared with the application store when the heights agree.
	ConsensusAppHash []byte
}

// ReconciliationKind classifies the outcome. Only kinds that end in an error
// leave the application store unchanged.
type ReconciliationKind string

const (
	// ReconcileAlreadySynced: application, consensus state and block store agree.
	ReconcileAlreadySynced ReconciliationKind = "already-synced"
	// ReconcileReplayed: the application was behind and advanced by verified
	// replay of the exact committed blocks.
	ReconcileReplayed ReconciliationKind = "replayed"
	// ReconcileBlockStoreAhead: the block store is one block ahead of the
	// consensus state. The application was not advanced because doing so needs a
	// verified record whose post-state matches the durable FinalizeBlock
	// response, which this layer cannot read from the state store.
	ReconcileBlockStoreAhead ReconciliationKind = "block-store-ahead"
)

// ReconciliationResult describes a successful reconciliation attempt.
type ReconciliationResult struct {
	Kind        ReconciliationKind
	FromHeight  uint64
	ToHeight    uint64
	Replayed    int
	EvidenceRef [walDigestSize]byte
}

// ReconcileApplicationState advances the application store, if and only if
// every block it adopts carries independently verified commit evidence and
// replays to the recorded post-block app hash. It never rewinds the application
// store and never treats a local snapshot as proof of consensus.
func ReconcileApplicationState(app *Store, view ConsensusDurabilityView, source *verifiedBlockSource) (ReconciliationResult, error) {
	var result ReconciliationResult
	if app == nil {
		return result, ErrStoreClosed
	}
	if err := app.ready(); err != nil {
		return result, err
	}
	result.FromHeight = app.Height()
	result.ToHeight = app.Height()
	if view.BlockStoreHeight < 0 || view.ConsensusStateHeight < 0 {
		return result, fmt.Errorf("%w: negative durable height", ErrReconciliationConflict)
	}
	// CometBFT's own invariants. Both are checked before the application store is
	// touched: v0.38.26 panics on the first and returns a typed error on the second.
	if view.ConsensusStateHeight > view.BlockStoreHeight {
		return result, fmt.Errorf("%w: state %d, blocks %d",
			ErrConsensusStateAheadOfBlockStore, view.ConsensusStateHeight, view.BlockStoreHeight)
	}
	if view.BlockStoreHeight > view.ConsensusStateHeight+1 {
		return result, fmt.Errorf("%w: state %d, blocks %d",
			ErrConsensusHistoryGap, view.ConsensusStateHeight, view.BlockStoreHeight)
	}
	appHeight := int64(app.Height())
	if appHeight > view.BlockStoreHeight {
		return result, fmt.Errorf("%w: application %d, blocks %d",
			ErrAppAheadOfConsensus, appHeight, view.BlockStoreHeight)
	}
	// At equal heights the two stores must describe the same state. A mismatch
	// means one of them was reset or replaced; reconciling would silently pick a
	// winner, so this fails closed.
	if appHeight == view.ConsensusStateHeight && len(view.ConsensusAppHash) > 0 {
		if !bytes.Equal(app.AppHash(), view.ConsensusAppHash) {
			return result, fmt.Errorf("%w: app hash differs from the consensus state at height %d",
				ErrReconciliationConflict, appHeight)
		}
	}
	// A pruned block store cannot replay the blocks the application is missing.
	if appHeight+1 < view.BlockStoreBase && view.BlockStoreHeight > 0 {
		return result, fmt.Errorf("%w: application %d is below block store base %d",
			ErrMissingVerifiedBlock, appHeight, view.BlockStoreBase)
	}
	advanced := 0
	for height := uint64(appHeight) + 1; height <= uint64(view.BlockStoreHeight); height++ {
		record, err := source.VerifiedBlock(height)
		if err != nil {
			return result, err
		}
		// AppendBlock re-checks project/genesis/chain binding, replays the exact
		// transactions, compares the post-block app hash, rejects a conflicting
		// block at an adopted height and fsyncs before the transition is current.
		applied, err := app.AppendBlock(record)
		if err != nil {
			return result, err
		}
		if !applied {
			// Already durable; verified replay must be idempotent.
			continue
		}
		advanced++
		result.EvidenceRef = record.CommitEvidenceDigest
	}
	result.ToHeight = app.Height()
	result.Replayed = advanced
	switch {
	case advanced > 0:
		result.Kind = ReconcileReplayed
	case view.BlockStoreHeight == view.ConsensusStateHeight+1 && appHeight == view.ConsensusStateHeight:
		// The application and the consensus state are one block behind the block
		// store. v0.38.26 can only finish this by re-executing the block and
		// checking the result against the durable FinalizeBlock response, which is
		// not readable through this boundary.
		result.Kind = ReconcileBlockStoreAhead
	default:
		result.Kind = ReconcileAlreadySynced
	}
	return result, nil
}
