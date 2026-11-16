package verifier

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	abci "github.com/cometbft/cometbft/abci/types"
	sm "github.com/cometbft/cometbft/state"
	"github.com/cometbft/cometbft/types"
)

// TestCaseA_BlockDurableApplicationBehind is the real window: the block reached
// the block store and the process died before FinalizeBlock or Commit. On restart
// the pinned handshake re-executes the block against the application, and the
// application only advances through its verified ZWB1 record.
func TestCaseA_BlockDurableApplicationBehind(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	appState, err := NewStateMachine(h.cfg.ProjectID, h.cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	record := testStoreBlock(t, appState, h.cfg, 1)
	preBlockAppHash := append([]byte(nil), appState.AppHash()...)
	source := recordSource(t, map[uint64]WALBlockRecord{1: record}, nil)

	if err := h.stateStore().Save(h.state); err != nil {
		t.Fatal(err)
	}
	h.openApp(source)
	if !bytes.Equal(h.appStore.AppHash(), preBlockAppHash) {
		t.Fatal("application genesis hash disagrees with the harness fixture")
	}
	// The only durable side effect before the crash is the block itself.
	blockID := saveBlock(t, h.blockStore(), h.validInitialBlock(record))
	if err := h.db.Crash(); err != nil {
		t.Fatal(err)
	}

	// Restart: the application is reopened, the CometBFT stores are re-read from
	// their durable contents, and the real handshake runs.
	h.openApp(source)
	if h.appHeight() != 0 {
		t.Fatalf("application started at height %d, want 0", h.appHeight())
	}
	h.loadState()
	replayedHash, err := h.replay(h.appStore.AppHash(), h.appHeight())
	if err != nil {
		t.Fatalf("handshake replay failed: %v", err)
	}
	if h.appHeight() != 1 {
		t.Fatalf("application height after replay = %d, want 1", h.appHeight())
	}
	if !bytes.Equal(replayedHash, record.PostBlockAppHash[:]) {
		t.Fatal("replayed hash differs from the verified record's post-block app hash")
	}
	state := h.loadState()
	if state.LastBlockHeight != 1 {
		t.Fatalf("consensus state height = %d, want 1", state.LastBlockHeight)
	}
	if !bytes.Equal(state.AppHash, record.PostBlockAppHash[:]) {
		t.Fatal("consensus state app hash differs from the application store")
	}
	if !bytes.Equal(state.LastBlockID.Hash, blockID.Hash) {
		t.Fatal("consensus state does not reference the durable block")
	}
	if h.app.finalizeCalls != 1 || h.app.commitCalls != 1 {
		t.Fatalf("unexpected ABCI calls: finalize=%d commit=%d", h.app.finalizeCalls, h.app.commitCalls)
	}

	// The reconciliation layer must agree with the recovered stores.
	reconciliation, err := ReconcileApplicationState(h.appStore, ConsensusDurabilityView{
		BlockStoreBase:       h.blockStore().Base(),
		BlockStoreHeight:     h.blockStore().Height(),
		ConsensusStateHeight: state.LastBlockHeight,
		ConsensusAppHash:     state.AppHash,
	}, source)
	if err != nil {
		t.Fatalf("reconcile after recovery: %v", err)
	}
	if reconciliation.Kind != ReconcileAlreadySynced {
		t.Fatalf("reconciliation kind = %s, want already-synced", reconciliation.Kind)
	}
}

// TestCaseA_ApplicationDidNotPersistInCommit is the pinned spec's second recovery
// case: block and CometBFT state are durable but the application is behind. The
// handshake replays both blocks, cross-checking each block's AppHash against the
// previous replay result, and requires the final hash to equal the durable state.
func TestCaseA_ApplicationDidNotPersistInCommit(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	appState, err := NewStateMachine(h.cfg.ProjectID, h.cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	first := testStoreBlock(t, appState, h.cfg, 1)
	afterFirst := appState.Clone()
	if err := afterFirst.Replay(first.Transactions); err != nil {
		t.Fatal(err)
	}
	second := testStoreBlock(t, afterFirst, h.cfg, 2)
	afterSecond := afterFirst.Clone()
	if err := afterSecond.Replay(second.Transactions); err != nil {
		t.Fatal(err)
	}
	source := recordSource(t, map[uint64]WALBlockRecord{1: first, 2: second}, nil)

	validator := h.state.Validators.Validators[0]
	blockOne := h.validInitialBlock(first)
	partsOne, err := blockOne.MakePartSet(types.BlockPartSizeBytes)
	if err != nil {
		t.Fatal(err)
	}
	lastCommit := &types.Commit{
		Height:  1,
		Round:   0,
		BlockID: types.BlockID{Hash: blockOne.Hash(), PartSetHeader: partsOne.Header()},
		Signatures: []types.CommitSig{{
			BlockIDFlag:      types.BlockIDFlagCommit,
			ValidatorAddress: append([]byte(nil), validator.Address...),
			Timestamp:        testGenesisTime().Add(time.Second),
			Signature:        bytes.Repeat([]byte{0x01}, 64),
		}},
	}
	blockTwo := buildBlock(t, second, afterFirst.AppHash(), lastCommit)
	blockTwo.Header.ChainID = h.state.ChainID
	blockTwo.Header.ProposerAddress = h.state.Validators.Proposer.Address
	blockIDOne := saveBlock(t, h.blockStore(), blockOne)
	saveBlock(t, h.blockStore(), blockTwo)

	// The genesis state must be saved so the validator set at height 1 is
	// available to build the last-commit info for block 2.
	if err := h.stateStore().Save(h.state); err != nil {
		t.Fatal(err)
	}
	stateAtTwo := h.stateAtHeight(2, afterSecond.AppHash(), blockIDOne)
	if err := h.stateStore().Save(stateAtTwo); err != nil {
		t.Fatal(err)
	}
	if err := h.db.Crash(); err != nil {
		t.Fatal(err)
	}

	h.openApp(source)
	h.loadState()
	replayed, err := h.replay(h.appStore.AppHash(), 0)
	if err != nil {
		t.Fatalf("handshake replay of two blocks failed: %v", err)
	}
	if h.appHeight() != 2 {
		t.Fatalf("application height = %d, want 2", h.appHeight())
	}
	if !bytes.Equal(replayed, afterSecond.AppHash()) {
		t.Fatal("replayed hash differs from the expected post-block-2 app hash")
	}
	if !bytes.Equal(h.loadState().AppHash, afterSecond.AppHash()) {
		t.Fatal("consensus state app hash differs from the replayed application state")
	}
	if h.app.finalizeCalls != 2 {
		t.Fatalf("finalize calls = %d, want 2", h.app.finalizeCalls)
	}
}

// TestCaseB_ApplicationAheadOfBlockStore: the pinned handshake returns a typed
// error and never rewinds or re-derives the application store.
func TestCaseB_ApplicationAheadOfBlockStore(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	appState, err := NewStateMachine(h.cfg.ProjectID, h.cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	first := testStoreBlock(t, appState, h.cfg, 1)
	afterFirst := appState.Clone()
	if err := afterFirst.Replay(first.Transactions); err != nil {
		t.Fatal(err)
	}
	second := testStoreBlock(t, afterFirst, h.cfg, 2)
	source := recordSource(t, map[uint64]WALBlockRecord{1: first, 2: second}, nil)
	// The application advanced to height 2 on its own.
	h.openApp(source)
	for _, record := range []WALBlockRecord{first, second} {
		if applied, err := h.appStore.AppendBlock(record); err != nil || !applied {
			t.Fatalf("advance application to height %d: applied=%v err=%v", record.Height, applied, err)
		}
	}
	appHashBefore := append([]byte(nil), h.appStore.AppHash()...)

	// Only block 1 is durable in CometBFT.
	blockIDOne := saveBlock(t, h.blockStore(), h.validInitialBlock(first))
	if err := h.stateStore().Save(h.stateAtHeight(1, first.PostBlockAppHash[:], blockIDOne)); err != nil {
		t.Fatal(err)
	}
	h.loadState()
	_, err = h.replay(appHashBefore, 2)
	var tooHigh sm.ErrAppBlockHeightTooHigh
	if !errors.As(err, &tooHigh) {
		t.Fatalf("handshake error = %v, want ErrAppBlockHeightTooHigh", err)
	}
	if tooHigh.CoreHeight != 1 || tooHigh.AppHeight != 2 {
		t.Fatalf("unexpected typed heights: %+v", tooHigh)
	}
	if h.appHeight() != 2 || !bytes.Equal(h.appStore.AppHash(), appHashBefore) {
		t.Fatal("handshake modified the application store while failing closed")
	}

	// The reconciliation layer must classify the same situation as a hard stop,
	// not as recoverable lag.
	_, err = ReconcileApplicationState(h.appStore, ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     1,
		ConsensusStateHeight: 1,
		ConsensusAppHash:     first.PostBlockAppHash[:],
	}, source)
	if !errors.Is(err, ErrAppAheadOfConsensus) {
		t.Fatalf("reconciliation error = %v, want ErrAppAheadOfConsensus", err)
	}
	if h.appHeight() != 2 {
		t.Fatal("reconciliation rewound the application store")
	}
}

// TestCaseB_EmptyBlockStorePanicsInsteadOfRollingBack shows that with no durable
// block at all, the pinned handshake asserts rather than silently accepting or
// rolling back the application's state.
func TestCaseB_EmptyBlockStorePanicsInsteadOfRollingBack(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	appState, err := NewStateMachine(h.cfg.ProjectID, h.cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	first := testStoreBlock(t, appState, h.cfg, 1)
	source := recordSource(t, map[uint64]WALBlockRecord{1: first}, nil)
	h.openApp(source)
	if applied, err := h.appStore.AppendBlock(first); err != nil || !applied {
		t.Fatalf("advance application: applied=%v err=%v", applied, err)
	}
	appHash := append([]byte(nil), h.appStore.AppHash()...)
	appHeight := h.appHeight()
	if h.blockStore().Height() != 0 {
		t.Fatal("harness unexpectedly has a durable block")
	}
	defer func() {
		recovered := recover()
		if recovered == nil {
			t.Fatal("handshake accepted an application height with no durable block")
		}
		if !strings.Contains(fmt.Sprint(recovered), "Did you reset CometBFT") {
			t.Fatalf("unexpected panic value: %v", recovered)
		}
		if h.appHeight() != appHeight || !bytes.Equal(h.appStore.AppHash(), appHash) {
			t.Fatal("application store changed during the failing handshake")
		}
	}()
	_, _ = h.replay(appHash, appHeight)
}

// TestCaseW2_ApplicationCommittedButStateNotSaved covers the window after the
// application's Commit and before state.Store.Save. The pinned handshake
// fast-forwards its own state from the durable FinalizeBlock response instead of
// re-executing the application.
func TestCaseW2_ApplicationCommittedButStateNotSaved(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	appState, err := NewStateMachine(h.cfg.ProjectID, h.cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	record := testStoreBlock(t, appState, h.cfg, 1)
	afterFirst := appState.Clone()
	if err := afterFirst.Replay(record.Transactions); err != nil {
		t.Fatal(err)
	}
	source := recordSource(t, map[uint64]WALBlockRecord{1: record}, nil)

	if err := h.stateStore().Save(h.state); err != nil {
		t.Fatal(err)
	}
	saveBlock(t, h.blockStore(), h.validInitialBlock(record))
	if err := h.stateStore().SaveFinalizeBlockResponse(1, &abci.ResponseFinalizeBlock{
		AppHash:   afterFirst.AppHash(),
		TxResults: []*abci.ExecTxResult{{}},
	}); err != nil {
		t.Fatal(err)
	}
	h.openApp(source)
	if applied, err := h.appStore.AppendBlock(record); err != nil || !applied {
		t.Fatalf("advance application: applied=%v err=%v", applied, err)
	}
	finalizeBefore := h.app.finalizeCalls
	commitBefore := h.app.commitCalls
	if err := h.db.Crash(); err != nil {
		t.Fatal(err)
	}

	h.openApp(source)
	h.loadState()
	replayed, err := h.replay(h.appStore.AppHash(), 1)
	if err != nil {
		t.Fatalf("handshake fast-forward failed: %v", err)
	}
	if !bytes.Equal(replayed, afterFirst.AppHash()) {
		t.Fatal("fast-forwarded hash differs from the durable FinalizeBlock response")
	}
	state := h.loadState()
	if state.LastBlockHeight != 1 || !bytes.Equal(state.AppHash, afterFirst.AppHash()) {
		t.Fatalf("consensus state was not fast-forwarded: height %d", state.LastBlockHeight)
	}
	if h.app.finalizeCalls != finalizeBefore || h.app.commitCalls != commitBefore {
		t.Fatal("application was re-executed even though it had already committed")
	}
}
