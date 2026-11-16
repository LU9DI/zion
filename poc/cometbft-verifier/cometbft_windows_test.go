package verifier

import (
	"bytes"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"
	"github.com/cometbft/cometbft/types"
)

// These tests reproduce the D5 crash windows against the real pinned CometBFT
// v0.38.26 stores and handshake. Every persistence step below is the real
// implementation; only the durability of the database is modelled.

// TestDurabilityBlockStoreSaveBlockIsAtomicAndSynchronized proves that the pinned
// BlockStore.SaveBlock batch (block parts, meta, hash index, last commit, seen
// commit and the BlockStoreState descriptor) is written with WriteSync, so a
// crash either loses the whole block or keeps all of it.
func TestDurabilityBlockStoreSaveBlockIsAtomicAndSynchronized(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	appState, err := NewStateMachine(h.cfg.ProjectID, h.cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	record := testStoreBlock(t, appState, h.cfg, 1)
	saveBlock(t, h.blockStore(), h.validInitialBlock(record))
	if h.db.syncedBatch == 0 {
		t.Fatal("SaveBlock performed no synchronized batch write")
	}
	if err := h.db.Crash(); err != nil {
		t.Fatal(err)
	}
	reopened := h.blockStore()
	if reopened.Height() != 1 {
		t.Fatalf("block store height after crash = %d, want 1", reopened.Height())
	}
	if reopened.LoadBlock(1) == nil {
		t.Fatal("block body did not survive the crash")
	}
	if reopened.LoadBlockMeta(1) == nil {
		t.Fatal("block meta did not survive the crash")
	}
}

// TestDurabilityStateStoreSaveIsSynchronized covers state.Store.Save.
func TestDurabilityStateStoreSaveIsSynchronized(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	state := h.stateAtHeight(1, bytes.Repeat([]byte{0x11}, 32), types.BlockID{})
	if err := h.stateStore().Save(state); err != nil {
		t.Fatalf("save consensus state: %v", err)
	}
	if h.db.syncedBatch == 0 {
		t.Fatal("state store Save performed no synchronized batch write")
	}
	if err := h.db.Crash(); err != nil {
		t.Fatal(err)
	}
	loaded := h.loadState()
	if loaded.LastBlockHeight != 1 || !bytes.Equal(loaded.AppHash, state.AppHash) {
		t.Fatalf("consensus state did not survive the crash: height %d", loaded.LastBlockHeight)
	}
}

// TestDurabilityFinalizeBlockResponseOnlyLastIsSynchronized documents the
// asymmetry in state.Store.SaveFinalizeBlockResponse: the per-height response is
// written with Set and the last response with SetSync, so only the latter is
// guaranteed to survive a crash.
func TestDurabilityFinalizeBlockResponseOnlyLastIsSynchronized(t *testing.T) {
	h := newCometBFTHarness(t)
	defer h.close()
	store := h.stateStore()
	first := &abci.ResponseFinalizeBlock{AppHash: bytes.Repeat([]byte{0x21}, 32)}
	second := &abci.ResponseFinalizeBlock{AppHash: bytes.Repeat([]byte{0x22}, 32)}
	if err := store.SaveFinalizeBlockResponse(1, first); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveFinalizeBlockResponse(2, second); err != nil {
		t.Fatal(err)
	}
	if err := h.db.Crash(); err != nil {
		t.Fatal(err)
	}
	reopened := h.stateStore()
	last, err := reopened.LoadLastFinalizeBlockResponse(2)
	if err != nil {
		t.Fatalf("last FinalizeBlock response did not survive the crash: %v", err)
	}
	if !bytes.Equal(last.AppHash, second.AppHash) {
		t.Fatal("last FinalizeBlock response changed across the crash")
	}
	if _, err := reopened.LoadFinalizeBlockResponse(1); err == nil {
		t.Fatal("a per-height response written with Set unexpectedly survived a crash")
	}
}
