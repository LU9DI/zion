package verifier

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/cometbft/cometbft/types"
)

func testStoreConfig() StoreConfig {
	genesis := sha256.Sum256([]byte("genesis-alpha"))
	return StoreConfig{
		ProjectID:     "project-alpha",
		GenesisDigest: genesis[:],
		ChainID:       "zion-store-test-1",
	}
}

func mustOpenStore(t *testing.T, dir string, cfg StoreConfig) *Store {
	t.Helper()
	store, err := OpenStore(dir, cfg)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return store
}

// testStoreBlock builds a block whose post-block app hash is the exact result of
// replaying its own transactions, the same contract a verified commit provides.
func testStoreBlock(t *testing.T, state *StateMachine, cfg StoreConfig, height uint64) WALBlockRecord {
	t.Helper()
	tx := testStateTx(t, cfg.ProjectID, byte(height), statePut, state.Sequence(),
		fmt.Sprintf("key/%d", height), fmt.Sprintf("value/%d", height))
	candidate := state.Clone()
	if err := candidate.Replay([][]byte{tx}); err != nil {
		t.Fatalf("replay candidate block %d: %v", height, err)
	}
	record := WALBlockRecord{
		RecordNumber:  height,
		ProjectID:     cfg.ProjectID,
		GenesisDigest: toDigest(cfg.GenesisDigest),
		ChainID:       cfg.ChainID,
		Height:        height,
		BlockID: types.BlockID{
			Hash:          bytes.Repeat([]byte{byte(height)}, 32),
			PartSetHeader: types.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{byte(height) ^ 0x5a}, 32)},
		},
		Transactions:     [][]byte{tx},
		PostBlockAppHash: toDigest(candidate.AppHash()),
	}
	for i := range record.CommitEvidenceDigest {
		record.CommitEvidenceDigest[i] = byte(height) ^ 0x11
	}
	// The codec requires a nonzero predecessor for any record after the first.
	// The store owns the real chain link and overwrites this placeholder.
	previous := sha256.Sum256([]byte(fmt.Sprintf("placeholder-predecessor/%d", height)))
	record.PreviousDigest = previous
	return record
}

func appendBlocks(t *testing.T, store *Store, cfg StoreConfig, count int) {
	t.Helper()
	for i := 0; i < count; i++ {
		record := testStoreBlock(t, store.State(), cfg, store.Height()+1)
		applied, err := store.AppendBlock(record)
		if err != nil {
			t.Fatalf("append block %d: %v", record.Height, err)
		}
		if !applied {
			t.Fatalf("append block %d reported an idempotent replay", record.Height)
		}
	}
}

func lastSegmentPath(t *testing.T, dir string) string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "wal"))
	if err != nil {
		t.Fatalf("read wal directory: %v", err)
	}
	if len(entries) == 0 {
		t.Fatal("wal directory is empty")
	}
	return filepath.Join(dir, "wal", entries[len(entries)-1].Name())
}

func TestStorePersistsAndRecoversCommittedBlocks(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 3)
	wantHash := store.AppHash()
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	report := reopened.lastReport
	if reopened.Height() != 3 {
		t.Fatalf("recovered height = %d, want 3", reopened.Height())
	}
	if !bytes.Equal(reopened.AppHash(), wantHash) {
		t.Fatal("recovered app hash differs from the committed one")
	}
	if report.ReplayedBlocks != 3 || report.SnapshotHeight != 0 || report.TruncatedTailBytes != 0 {
		t.Fatalf("unexpected recovery report: %+v", report)
	}
}

func TestStoreRecoversFromPublishedGeneration(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 3)
	if err := store.PublishGeneration(); err != nil {
		t.Fatalf("publish generation: %v", err)
	}
	wantHash := store.AppHash()
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	if reopened.Height() != 3 || !bytes.Equal(reopened.AppHash(), wantHash) {
		t.Fatalf("generation recovery produced height=%d", reopened.Height())
	}
	if reopened.lastReport.SnapshotHeight != 3 || reopened.lastReport.ReplayedBlocks != 0 {
		t.Fatalf("unexpected recovery report: %+v", reopened.lastReport)
	}

	appendBlocks(t, reopened, cfg, 1)
	if err := reopened.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	third := mustOpenStore(t, dir, cfg)
	defer third.Close()
	if third.Height() != 4 || third.lastReport.ReplayedBlocks != 1 {
		t.Fatalf("expected generation 3 plus one replayed block, got %+v", third.lastReport)
	}
}

func TestStoreIdempotentReplayAndConflictAtSameHeight(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	defer store.Close()

	genesis := store.State()
	first := testStoreBlock(t, genesis, cfg, 1)
	if applied, err := store.AppendBlock(first); err != nil || !applied {
		t.Fatalf("append first block: applied=%v err=%v", applied, err)
	}
	applied, err := store.AppendBlock(first)
	if err != nil {
		t.Fatalf("idempotent replay of block 1 failed: %v", err)
	}
	if applied {
		t.Fatal("idempotent replay was reported as a new durable commit")
	}
	if store.Height() != 1 {
		t.Fatalf("height advanced on idempotent replay: %d", store.Height())
	}

	conflicting := first
	wrongHash := sha256.Sum256([]byte("a different block at the same height"))
	conflicting.PostBlockAppHash = wrongHash
	if _, err := store.AppendBlock(conflicting); !errors.Is(err, ErrStoreConflict) {
		t.Fatalf("conflicting block at committed height error = %v, want ErrStoreConflict", err)
	}

	gap := testStoreBlock(t, store.State(), cfg, 3)
	if _, err := store.AppendBlock(gap); err == nil {
		t.Fatal("height gap was accepted as the next block")
	}
	if store.Height() != 1 {
		t.Fatalf("rejected block advanced the height to %d", store.Height())
	}
}

func TestStoreRejectsWrongPostBlockAppHash(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	record := testStoreBlock(t, store.State(), cfg, 1)
	wrongHash := sha256.Sum256([]byte("wrong post-block state"))
	record.PostBlockAppHash = wrongHash
	if _, err := store.AppendBlock(record); !errors.Is(err, ErrStoreStateMismatch) {
		t.Fatalf("wrong post-block app hash error = %v, want ErrStoreStateMismatch", err)
	}
	if store.Height() != 0 {
		t.Fatalf("rejected block advanced the height to %d", store.Height())
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	if reopened.Height() != 0 {
		t.Fatalf("rejected block was durable: height=%d", reopened.Height())
	}
}

// tornTailPrefixes returns a deterministic sample of frame prefixes covering the
// length header, the fixed fields, the payload and the trailing checksum. The
// full per-byte sweep is covered by TestWALBlockRecordRejectsTruncationAtEveryBoundary
// at the codec level; this test proves the store's discard policy itself.
func tornTailPrefixes(total int) []int {
	candidates := []int{1, 2, 3, 4, 5, 6, 7, 8, 12, 24, 48, 96,
		total / 2, total - 70, total - 34, total - 33, total - 32,
		total - 31, total - 24, total - 16, total - 8, total - 4, total - 1}
	seen := make(map[int]bool, len(candidates))
	var prefixes []int
	for _, candidate := range candidates {
		if candidate > 0 && candidate < total && !seen[candidate] {
			seen[candidate] = true
			prefixes = append(prefixes, candidate)
		}
	}
	return prefixes
}

// TestStoreDiscardsTornTailAtRepresentativeBoundaries simulates a crash while
// writing the next frame: a partial prefix of a valid frame must be discarded and
// the committed prefix must remain intact. Each prefix is applied to a copy of a
// prepared store so the test performs no extra durable appends.
func TestStoreDiscardsTornTailAtRepresentativeBoundaries(t *testing.T) {
	cfg := testStoreConfig()
	base := t.TempDir()
	store := mustOpenStore(t, base, cfg)
	appendBlocks(t, store, cfg, 2)
	third := testStoreBlock(t, store.State(), cfg, 3)
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	fullFrame, err := EncodeWALBlockRecord(third)
	if err != nil {
		t.Fatalf("encode third block: %v", err)
	}
	framed := appendUint32(nil, uint32(len(fullFrame)))
	framed = append(framed, fullFrame...)

	for _, prefix := range tornTailPrefixes(len(framed)) {
		dir := t.TempDir()
		copyStoreDirectory(t, base, dir)
		path := lastSegmentPath(t, dir)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			t.Fatalf("open segment: %v", err)
		}
		if _, err := file.Write(framed[:prefix]); err != nil {
			t.Fatalf("write partial frame: %v", err)
		}
		if err := file.Close(); err != nil {
			t.Fatalf("close segment: %v", err)
		}
		reopened, err := OpenStore(dir, cfg)
		if err != nil {
			t.Fatalf("prefix %d: recover store: %v", prefix, err)
		}
		if reopened.Height() != 2 {
			t.Fatalf("prefix %d: recovered height = %d, want 2", prefix, reopened.Height())
		}
		if reopened.lastReport.TruncatedTailBytes != int64(prefix) {
			t.Fatalf("prefix %d: reported %d discarded bytes", prefix, reopened.lastReport.TruncatedTailBytes)
		}
		if err := reopened.Close(); err != nil {
			t.Fatalf("prefix %d: close reopened store: %v", prefix, err)
		}
	}

	// After discarding a suffix the store must remain usable.
	dir := t.TempDir()
	copyStoreDirectory(t, base, dir)
	file, err := os.OpenFile(lastSegmentPath(t, dir), os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(framed[:len(framed)-1]); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	appendBlocks(t, reopened, cfg, 1)
	if reopened.Height() != 3 {
		t.Fatalf("store could not append after discarding a torn tail: height=%d", reopened.Height())
	}
}

// copyStoreDirectory copies a prepared store tree so a test can inject damage
// without repeating durable writes.
func copyStoreDirectory(t *testing.T, from, to string) {
	t.Helper()
	entries, err := os.ReadDir(from)
	if err != nil {
		t.Fatalf("read %s: %v", from, err)
	}
	for _, entry := range entries {
		source := filepath.Join(from, entry.Name())
		target := filepath.Join(to, entry.Name())
		if entry.IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				t.Fatal(err)
			}
			copyStoreDirectory(t, source, target)
			continue
		}
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatalf("read %s: %v", source, err)
		}
		if err := os.WriteFile(target, data, 0o600); err != nil {
			t.Fatalf("write %s: %v", target, err)
		}
	}
}

func TestStoreFailsClosedOnMidLogCorruption(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 3)
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	path := lastSegmentPath(t, dir)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Flip a byte inside the first frame's payload; the frame length and the
	// following frames stay intact, so this is corruption, not a torn tail.
	data[len(data)/6] ^= 0xff
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(dir, cfg); !errors.Is(err, ErrStoreCorrupt) {
		t.Fatalf("mid-log corruption error = %v, want ErrStoreCorrupt", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if before.Size() != after.Size() {
		t.Fatal("corrupt WAL segment was silently truncated")
	}
}

func TestStoreFailsClosedOnCorruptFinalFrameChecksum(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 2)
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	path := lastSegmentPath(t, dir)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// The declared frame length is fully present; only the checksum is wrong.
	data[len(data)-1] ^= 0xff
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(dir, cfg); !errors.Is(err, ErrStoreCorrupt) {
		t.Fatalf("corrupt final frame error = %v, want ErrStoreCorrupt", err)
	}
}

func TestStoreDetectsWALBehindPublishedGeneration(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 2)
	if err := store.PublishGeneration(); err != nil {
		t.Fatalf("publish generation: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	if err := os.Remove(lastSegmentPath(t, dir)); err != nil {
		t.Fatalf("remove WAL segment: %v", err)
	}
	if _, err := OpenStore(dir, cfg); !errors.Is(err, ErrStoreRollback) {
		t.Fatalf("WAL behind generation error = %v, want ErrStoreRollback", err)
	}
}

func TestStoreDetectsGenerationReferencingAnotherWALRecord(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 2)
	if err := store.PublishGeneration(); err != nil {
		t.Fatalf("publish generation: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	manifestPath := filepath.Join(dir, "generations", formatGenerationName(2)+".manifest")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	generation, err := decodeStoreManifest(raw, cfg)
	if err != nil {
		t.Fatal(err)
	}
	otherRecord := sha256.Sum256([]byte("another record"))
	generation.WALRecordDigest = otherRecord
	tampered, err := encodeStoreManifest(cfg, generation)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, tampered, 0o600); err != nil {
		t.Fatal(err)
	}
	current, err := encodeStoreCurrent(storeCurrent{
		Height:         2,
		ManifestDigest: sha256.Sum256(tampered),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CURRENT"), current, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(dir, cfg); !errors.Is(err, ErrStoreRollback) {
		t.Fatalf("generation/WAL binding error = %v, want ErrStoreRollback", err)
	}
}

// TestStoreOlderGenerationReplaysForward proves that an older CURRENT pointer is
// not data loss: the WAL still reaches the tip and the recovered state matches.
// A coordinated rollback of every local file is not detectable locally and is
// documented as an explicit limitation.
func TestStoreOlderGenerationReplaysForward(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 2)
	if err := store.PublishGeneration(); err != nil {
		t.Fatalf("publish generation: %v", err)
	}
	appendBlocks(t, store, cfg, 1)
	wantHash := store.AppHash()
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	currentPath := filepath.Join(dir, "CURRENT")
	manifest, err := os.ReadFile(filepath.Join(dir, "generations", formatGenerationName(2)+".manifest"))
	if err != nil {
		t.Fatal(err)
	}
	older, err := encodeStoreCurrent(storeCurrent{Height: 2, ManifestDigest: sha256.Sum256(manifest)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(currentPath, older, 0o600); err != nil {
		t.Fatal(err)
	}
	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	if reopened.Height() != 3 || !bytes.Equal(reopened.AppHash(), wantHash) {
		t.Fatalf("forward replay from an older generation produced height=%d", reopened.Height())
	}
	if reopened.lastReport.SnapshotHeight != 2 || reopened.lastReport.ReplayedBlocks != 1 {
		t.Fatalf("unexpected recovery report: %+v", reopened.lastReport)
	}
}

func TestStoreRejectsMissingOrMismatchedCurrent(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 1)
	if err := store.PublishGeneration(); err != nil {
		t.Fatalf("publish generation: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	currentPath := filepath.Join(dir, "CURRENT")
	if err := os.WriteFile(currentPath, []byte("ZONCUR1 1 deadbeef\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenStore(dir, cfg); !errors.Is(err, ErrStoreCorrupt) {
		t.Fatalf("malformed CURRENT error = %v, want ErrStoreCorrupt", err)
	}
}

func TestStoreRejectsIdentityMismatch(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 1)
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	wrongGenesis := sha256.Sum256([]byte("other-genesis"))
	for name, candidate := range map[string]StoreConfig{
		"other project": {ProjectID: "project-beta", GenesisDigest: cfg.GenesisDigest, ChainID: cfg.ChainID},
		"other genesis": {ProjectID: cfg.ProjectID, GenesisDigest: wrongGenesis[:], ChainID: cfg.ChainID},
		"other chain":   {ProjectID: cfg.ProjectID, GenesisDigest: cfg.GenesisDigest, ChainID: "zion-store-test-2"},
	} {
		store, err := OpenStore(dir, candidate)
		if err == nil {
			_ = store.Close()
			t.Fatalf("%s: store opened under a different identity", name)
		}
		if !errors.Is(err, ErrStoreFormat) {
			t.Fatalf("%s: error = %v, want ErrStoreFormat", name, err)
		}
	}
}

func TestStoreLockExcludesSecondOpen(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	first := mustOpenStore(t, dir, cfg)
	if _, err := OpenStore(dir, cfg); !errors.Is(err, ErrStoreLocked) {
		t.Fatalf("second open error = %v, want ErrStoreLocked", err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("close first store: %v", err)
	}
	second := mustOpenStore(t, dir, cfg)
	if err := second.Close(); err != nil {
		t.Fatalf("close second store: %v", err)
	}
}

func TestStoreFailsClosedAfterDurabilityFailure(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	store.faults.AfterWALWriteBeforeSync = func() error { return errors.New("injected sync failure") }
	record := testStoreBlock(t, store.State(), cfg, 1)
	if _, err := store.AppendBlock(record); !errors.Is(err, ErrStoreFailed) {
		t.Fatalf("injected durability failure error = %v, want ErrStoreFailed", err)
	}
	store.faults.AfterWALWriteBeforeSync = nil
	if _, err := store.AppendBlock(testStoreBlock(t, store.State(), cfg, 1)); !errors.Is(err, ErrStoreFailed) {
		t.Fatalf("store accepted writes after a durability failure: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	if reopened.Height() != 0 {
		t.Fatalf("rolled-back append became durable: height=%d", reopened.Height())
	}
}

func TestStorePublishFaultsKeepPreviousGeneration(t *testing.T) {
	for name, install := range map[string]func(*Store){
		"before current replace": func(s *Store) {
			s.faults.BeforeCurrentReplace = func() error { return errors.New("injected current failure") }
		},
		"before snapshot rename": func(s *Store) {
			s.faults.BeforeSnapshotRename = func() error { return errors.New("injected snapshot failure") }
		},
		"after snapshot rename": func(s *Store) {
			s.faults.AfterSnapshotRename = func() error { return errors.New("injected manifest failure") }
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			cfg := testStoreConfig()
			store := mustOpenStore(t, dir, cfg)
			appendBlocks(t, store, cfg, 1)
			if err := store.PublishGeneration(); err != nil {
				t.Fatalf("publish generation: %v", err)
			}
			appendBlocks(t, store, cfg, 1)
			wantHash := store.AppHash()
			install(store)
			if err := store.PublishGeneration(); !errors.Is(err, ErrStoreFailed) {
				t.Fatalf("injected publish failure error = %v, want ErrStoreFailed", err)
			}
			store.faults = storeFaults{}
			if err := store.Close(); err != nil {
				t.Fatalf("close store: %v", err)
			}
			reopened := mustOpenStore(t, dir, cfg)
			defer reopened.Close()
			if reopened.Height() != 2 || !bytes.Equal(reopened.AppHash(), wantHash) {
				t.Fatalf("recovery after a failed publish produced height=%d", reopened.Height())
			}
			if reopened.lastReport.SnapshotHeight != 1 {
				t.Fatalf("failed publish changed the visible generation: %+v", reopened.lastReport)
			}
			if err := reopened.PublishGeneration(); err != nil {
				t.Fatalf("publish after recovery: %v", err)
			}
			if reopened.publishedHeight != 2 {
				t.Fatalf("published height = %d, want 2", reopened.publishedHeight)
			}
		})
	}
}

func TestStoreRecoveryBounds(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 2)
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	bounded := cfg
	bounded.MaxRecoveryBlocks = 1
	if _, err := OpenStore(dir, bounded); !errors.Is(err, ErrStoreBounds) {
		t.Fatalf("recovery bound error = %v, want ErrStoreBounds", err)
	}
}

func TestStoreRotatesSegmentsAndRecoversAcrossThem(t *testing.T) {
	dir := t.TempDir()
	cfg := testStoreConfig()
	cfg.MaxSegmentBytes = 1024
	store := mustOpenStore(t, dir, cfg)
	appendBlocks(t, store, cfg, 6)
	wantHash := store.AppHash()
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "wal"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 2 {
		t.Fatalf("expected segment rotation, found %d segment(s)", len(entries))
	}
	reopened := mustOpenStore(t, dir, cfg)
	defer reopened.Close()
	if reopened.Height() != 6 || !bytes.Equal(reopened.AppHash(), wantHash) {
		t.Fatalf("multi-segment recovery produced height=%d", reopened.Height())
	}
	if reopened.lastReport.SegmentsScanned != len(entries) {
		t.Fatalf("scanned %d segments of %d", reopened.lastReport.SegmentsScanned, len(entries))
	}
}

// ---------------------------------------------------------------------------
// Process-level crash tests
// ---------------------------------------------------------------------------

// TestStoreCrashHelper is the child process used by the crash tests below. It is
// skipped unless the parent sets the helper environment variables.
func TestStoreCrashHelper(t *testing.T) {
	dir := os.Getenv("ZION_STORE_CRASH_DIR")
	point := os.Getenv("ZION_STORE_CRASH_POINT")
	if dir == "" || point == "" {
		t.Skip("crash helper process only")
	}
	cfg := testStoreConfig()
	store, err := OpenStore(dir, cfg)
	if err != nil {
		t.Fatalf("helper open store: %v", err)
	}
	switch point {
	case "after-wal-sync":
		store.faults.AfterWALSync = func() error {
			os.Exit(17)
			return nil
		}
	case "before-wal-sync":
		store.faults.AfterWALWriteBeforeSync = func() error {
			os.Exit(18)
			return nil
		}
	default:
		t.Fatalf("unknown crash point %q", point)
	}
	record := testStoreBlock(t, store.State(), cfg, 1)
	if _, err := store.AppendBlock(record); err != nil {
		t.Fatalf("helper append block: %v", err)
	}
	t.Fatal("helper did not crash at the requested point")
}

func runCrashHelper(t *testing.T, dir, point string) int {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=TestStoreCrashHelper", "-test.v=false")
	command.Env = append(os.Environ(),
		"ZION_STORE_CRASH_DIR="+dir,
		"ZION_STORE_CRASH_POINT="+point,
	)
	err := command.Run()
	if err == nil {
		t.Fatalf("crash helper for %q exited successfully", point)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("run crash helper: %v", err)
	}
	return exitErr.ExitCode()
}

func TestStoreSurvivesCrashAfterWALSync(t *testing.T) {
	dir := t.TempDir()
	if code := runCrashHelper(t, dir, "after-wal-sync"); code != 17 {
		t.Fatalf("crash helper exit code = %d, want 17", code)
	}
	cfg := testStoreConfig()
	recovered, err := OpenStore(dir, cfg)
	if err != nil {
		t.Fatalf("recover after crash: %v", err)
	}
	defer recovered.Close()
	if recovered.Height() != 1 {
		t.Fatalf("recovered height = %d, want 1", recovered.Height())
	}
	if recovered.lastReport.TruncatedTailBytes != 0 {
		t.Fatalf("synced record was reported as a torn tail: %+v", recovered.lastReport)
	}
	// The process lock must have been released by the dying process.
	appendBlocks(t, recovered, cfg, 1)
}

func TestStoreRecoversFromCrashBeforeWALSync(t *testing.T) {
	dir := t.TempDir()
	if code := runCrashHelper(t, dir, "before-wal-sync"); code != 18 {
		t.Fatalf("crash helper exit code = %d, want 18", code)
	}
	cfg := testStoreConfig()
	recovered, err := OpenStore(dir, cfg)
	if err != nil {
		t.Fatalf("recover after crash: %v", err)
	}
	defer recovered.Close()
	// The store never reported this block as durable. A process crash without
	// media loss can still leave the complete but unsynced frame visible, so
	// both outcomes are valid; a partial frame must be discarded.
	switch recovered.Height() {
	case 0:
		// Nothing durable was recorded; the store must still be usable.
		appendBlocks(t, recovered, cfg, 1)
		if recovered.Height() != 1 {
			t.Fatalf("recovered store could not start: height=%d", recovered.Height())
		}
	case 1:
		if recovered.lastReport.TruncatedTailBytes != 0 {
			t.Fatalf("complete unsynced record was reported as a torn tail: %+v", recovered.lastReport)
		}
		appendBlocks(t, recovered, cfg, 1)
		if recovered.Height() != 2 {
			t.Fatalf("recovered store could not continue: height=%d", recovered.Height())
		}
	default:
		t.Fatalf("unexpected recovered height %d", recovered.Height())
	}
}
