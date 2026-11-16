package verifier

import (
	"errors"
	"testing"
)

// reconcileFixture builds an application store at height 2 plus the verified
// records for heights 1 and 2, so tests can exercise reconciliation without
// touching CometBFT.
func reconcileFixture(t *testing.T) (StoreConfig, map[uint64]WALBlockRecord, *Store) {
	t.Helper()
	cfg := testStoreConfig()
	records := make(map[uint64]WALBlockRecord)
	dir := t.TempDir()
	store := mustOpenStore(t, dir, cfg)
	t.Cleanup(func() { _ = store.Close() })
	appState, err := NewStateMachine(cfg.ProjectID, cfg.GenesisDigest)
	if err != nil {
		t.Fatal(err)
	}
	for height := uint64(1); height <= 2; height++ {
		record := testStoreBlock(t, appState, cfg, height)
		candidate := appState.Clone()
		if err := candidate.Replay(record.Transactions); err != nil {
			t.Fatal(err)
		}
		records[height] = record
		appState = candidate
		if applied, err := store.AppendBlock(record); err != nil || !applied {
			t.Fatalf("advance fixture store to height %d: applied=%v err=%v", height, applied, err)
		}
	}
	return cfg, records, store
}

func TestReconcileReplaysVerifiedBlocksIntoApplication(t *testing.T) {
	cfg, records, advanced := reconcileFixture(t)
	wantHash := advanced.AppHash()
	wantHeight := advanced.Height()

	// A second, empty application store is the one being reconciled.
	fresh := mustOpenStore(t, t.TempDir(), cfg)
	defer fresh.Close()
	source := recordSource(t, records, nil)

	view := ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     2,
		ConsensusStateHeight: 2,
		ConsensusAppHash:     wantHash,
	}
	result, err := ReconcileApplicationState(fresh, view, source)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if result.Kind != ReconcileReplayed || result.Replayed != 2 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.FromHeight != 0 || result.ToHeight != wantHeight {
		t.Fatalf("unexpected heights: %+v", result)
	}
	if result.EvidenceRef != records[2].CommitEvidenceDigest {
		t.Fatal("result does not reference the last adopted commit evidence")
	}
	if fresh.Height() != wantHeight || !bytesEqual(fresh.AppHash(), wantHash) {
		t.Fatal("reconciled application state differs from the expected state")
	}

	// Idempotent: a second pass adopts nothing and stays synced.
	again, err := ReconcileApplicationState(fresh, view, source)
	if err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if again.Kind != ReconcileAlreadySynced || again.Replayed != 0 {
		t.Fatalf("second pass was not idempotent: %+v", again)
	}
	if fresh.Height() != wantHeight {
		t.Fatal("idempotent pass changed the application height")
	}
}

func TestReconcileRejectsApplicationAheadOfBlockStore(t *testing.T) {
	_, records, advanced := reconcileFixture(t)
	source := recordSource(t, records, nil)
	before := append([]byte(nil), advanced.AppHash()...)
	_, err := ReconcileApplicationState(advanced, ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     1,
		ConsensusStateHeight: 1,
		ConsensusAppHash:     postAppHash(records[1]),
	}, source)
	if !errors.Is(err, ErrAppAheadOfConsensus) {
		t.Fatalf("error = %v, want ErrAppAheadOfConsensus", err)
	}
	if advanced.Height() != 2 || !bytesEqual(advanced.AppHash(), before) {
		t.Fatal("failed reconciliation modified the application store")
	}
}

func TestReconcileRejectsImpossibleConsensusViews(t *testing.T) {
	_, records, store := reconcileFixture(t)
	source := recordSource(t, records, nil)
	cases := []struct {
		name string
		view ConsensusDurabilityView
		want error
	}{
		{
			name: "consensus state ahead of the block store",
			view: ConsensusDurabilityView{BlockStoreBase: 1, BlockStoreHeight: 2, ConsensusStateHeight: 3},
			want: ErrConsensusStateAheadOfBlockStore,
		},
		{
			name: "block store more than one ahead of the state",
			view: ConsensusDurabilityView{BlockStoreBase: 1, BlockStoreHeight: 4, ConsensusStateHeight: 2},
			want: ErrConsensusHistoryGap,
		},
		{
			name: "negative durable height",
			view: ConsensusDurabilityView{BlockStoreBase: 1, BlockStoreHeight: -1, ConsensusStateHeight: 0},
			want: ErrReconciliationConflict,
		},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := ReconcileApplicationState(store, tt.view, source); !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}
			if store.Height() != 2 {
				t.Fatal("rejected view changed the application store")
			}
		})
	}
}

func TestReconcileRejectsAppHashConflictAtEqualHeight(t *testing.T) {
	_, records, store := reconcileFixture(t)
	source := recordSource(t, records, nil)
	_, err := ReconcileApplicationState(store, ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     2,
		ConsensusStateHeight: 2,
		ConsensusAppHash:     postAppHash(records[1]),
	}, source)
	if !errors.Is(err, ErrReconciliationConflict) {
		t.Fatalf("error = %v, want ErrReconciliationConflict", err)
	}
	if store.Height() != 2 {
		t.Fatal("conflicting app hash changed the application store")
	}
}

func TestReconcileRequiresVerifiedEvidence(t *testing.T) {
	cfg, records, _ := reconcileFixture(t)
	fresh := mustOpenStore(t, t.TempDir(), cfg)
	defer fresh.Close()
	view := ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     2,
		ConsensusStateHeight: 2,
		ConsensusAppHash:     postAppHash(records[2]),
	}

	if _, err := NewVerifiedBlockSource(nil, func(WALBlockRecord) error { return nil }); err == nil {
		t.Fatal("a source without a loader was accepted")
	}
	if _, err := NewVerifiedBlockSource(func(uint64) (WALBlockRecord, error) { return WALBlockRecord{}, nil }, nil); err == nil {
		t.Fatal("a source without a verifier was accepted")
	}

	// Evidence verification failure blocks advancement entirely.
	reject := recordSource(t, records, func(WALBlockRecord) error { return errors.New("unverified") })
	_, err := ReconcileApplicationState(fresh, view, reject)
	if !errors.Is(err, ErrMissingVerifiedBlock) {
		t.Fatalf("error = %v, want ErrMissingVerifiedBlock", err)
	}
	if fresh.Height() != 0 {
		t.Fatalf("unverified evidence advanced the application to %d", fresh.Height())
	}

	// A missing block is equally fatal and indistinguishable from unverifiable.
	missing := recordSource(t, map[uint64]WALBlockRecord{1: records[1]}, nil)
	_, err = ReconcileApplicationState(fresh, view, missing)
	if !errors.Is(err, ErrMissingVerifiedBlock) {
		t.Fatalf("error = %v, want ErrMissingVerifiedBlock", err)
	}
	if fresh.Height() != 1 {
		t.Fatalf("application height = %d, want 1 after a partial verified replay", fresh.Height())
	}

	// A source that returns the wrong height is rejected before adoption.
	source, err := NewVerifiedBlockSource(func(uint64) (WALBlockRecord, error) {
		return records[1], nil
	}, func(WALBlockRecord) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReconcileApplicationState(fresh, view, source); !errors.Is(err, ErrMissingVerifiedBlock) {
		t.Fatalf("error = %v, want ErrMissingVerifiedBlock", err)
	}
}

func TestReconcileRejectsTamperedTransactionOrder(t *testing.T) {
	cfg, records, _ := reconcileFixture(t)
	fresh := mustOpenStore(t, t.TempDir(), cfg)
	defer fresh.Close()
	tampered := records[1]
	tampered.PostBlockAppHash = records[2].PostBlockAppHash
	source := recordSource(t, map[uint64]WALBlockRecord{1: tampered}, nil)
	_, err := ReconcileApplicationState(fresh, ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     1,
		ConsensusStateHeight: 1,
		ConsensusAppHash:     postAppHash(tampered),
	}, source)
	if !errors.Is(err, ErrStoreStateMismatch) {
		t.Fatalf("error = %v, want ErrStoreStateMismatch", err)
	}
	if fresh.Height() != 0 {
		t.Fatal("a record whose replay does not match its app hash was adopted")
	}
}

func TestReconcileRejectsPrunedBlockStoreBelowApplication(t *testing.T) {
	cfg, records, _ := reconcileFixture(t)
	fresh := mustOpenStore(t, t.TempDir(), cfg)
	defer fresh.Close()
	source := recordSource(t, records, nil)
	_, err := ReconcileApplicationState(fresh, ConsensusDurabilityView{
		BlockStoreBase:       5,
		BlockStoreHeight:     6,
		ConsensusStateHeight: 6,
	}, source)
	if !errors.Is(err, ErrMissingVerifiedBlock) {
		t.Fatalf("error = %v, want ErrMissingVerifiedBlock", err)
	}
	if fresh.Height() != 0 {
		t.Fatal("pruned block store advanced the application")
	}
}

func TestReconcileReportsBlockStoreOneAhead(t *testing.T) {
	cfg, records, _ := reconcileFixture(t)
	fresh := mustOpenStore(t, t.TempDir(), cfg)
	defer fresh.Close()
	if applied, err := fresh.AppendBlock(records[1]); err != nil || !applied {
		t.Fatalf("advance application: applied=%v err=%v", applied, err)
	}
	source := recordSource(t, map[uint64]WALBlockRecord{2: records[2]}, nil)
	// Application and consensus state at 1, block store at 2: finishing this needs
	// the durable FinalizeBlock response, which is outside this boundary.
	result, err := ReconcileApplicationState(fresh, ConsensusDurabilityView{
		BlockStoreBase:       1,
		BlockStoreHeight:     2,
		ConsensusStateHeight: 1,
		ConsensusAppHash:     postAppHash(records[1]),
	}, source)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if result.Kind != ReconcileReplayed || result.Replayed != 1 {
		t.Fatalf("unexpected result: %+v", result)
	}
	if fresh.Height() != 2 {
		t.Fatalf("application height = %d, want 2", fresh.Height())
	}
}

func postAppHash(record WALBlockRecord) []byte {
	return append([]byte(nil), record.PostBlockAppHash[:]...)
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
