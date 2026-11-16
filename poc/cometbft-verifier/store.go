package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/cometbft/cometbft/types"
)

// This file implements an experimental single-process durable store for the
// PoC application state. It is deliberately separate from CometBFT's block
// store and from any runtime integration.
//
// What it does provide:
//   - block-atomic ZWB1 records appended to length-framed WAL segments and
//     fsynced before the transition is treated as locally durable;
//   - candidate state derived by replaying the exact recorded transactions,
//     compared against the recorded post-block app hash, and adopted only after
//     the WAL append is durable;
//   - snapshot generations published through temporary files, rename and
//     directory sync, with a manifest binding the snapshot digest, block
//     identity, app hash and the WAL record digest it corresponds to;
//   - recovery that verifies the whole local record chain, discards a provably
//     uncommitted torn tail, and fails closed on mid-log corruption, gaps,
//     rollback or conflicting history.
//
// What it does not provide: authentication (the WAL is unkeyed), rollback
// resistance against an attacker who rewrites every local file, cross-store
// atomicity with CometBFT, or any production guarantee.

const (
	storeFormatMagic     = "ZON1"
	storeFormatVersion   = uint16(1)
	storeCurrentMagic    = "ZONCUR1"
	storeManifestMagic   = "ZONMAN1"
	storeManifestVersion = uint16(1)

	// DefaultMaxSegmentBytes rotates WAL segments so recovery work and single
	// file sizes stay bounded.
	DefaultMaxSegmentBytes = 64 << 20
	// DefaultMaxRecoveryBlocks bounds how many committed blocks a single
	// recovery replays before failing closed.
	DefaultMaxRecoveryBlocks = 100_000
)

var (
	ErrStoreLocked           = errors.New("store is locked by another process")
	ErrStoreFormat           = errors.New("store format or identity mismatch")
	ErrStoreCorrupt          = errors.New("store contains corrupt or unverifiable data")
	ErrStoreConflict         = errors.New("store already contains a different block at this height")
	ErrStoreRollback         = errors.New("store history is behind or inconsistent with its published generation")
	ErrStoreBounds           = errors.New("store exceeds configured bounds")
	ErrStoreClosed           = errors.New("store is closed")
	ErrStoreFailed           = errors.New("store has previously failed and is fail-closed")
	ErrStoreStateMismatch    = errors.New("replayed state does not match the committed post-block app hash")
	ErrStoreNotDurableHeight = errors.New("store has no complete block to publish")
)

// StoreConfig identifies the project/genesis/chain this store may contain.
// ProjectID, GenesisDigest and ChainID are the only trust inputs; nothing on
// disk is treated as an authority for them.
type StoreConfig struct {
	ProjectID     string
	GenesisDigest []byte
	ChainID       string
	// MaxSegmentBytes rotates WAL segments. Zero selects DefaultMaxSegmentBytes.
	MaxSegmentBytes int64
	// MaxRecoveryBlocks bounds blocks replayed during Open. Zero selects
	// DefaultMaxRecoveryBlocks.
	MaxRecoveryBlocks int
}

// RecoveryReport describes what Open observed. It never reports success for
// partially recovered state: a nonzero TruncatedTailBytes means an uncommitted
// suffix was discarded, and any unverifiable data is an error instead.
type RecoveryReport struct {
	SnapshotHeight     uint64
	ReplayedBlocks     int
	TruncatedTailBytes int64
	SegmentsScanned    int
	Height             uint64
}

// storeFaults allows tests to fail or abort at each durability boundary.
type storeFaults struct {
	BeforeWALWrite          func() error
	AfterWALWriteBeforeSync func() error
	AfterWALSync            func() error
	BeforeSnapshotWrite     func() error
	AfterSnapshotSync       func() error
	BeforeSnapshotRename    func() error
	AfterSnapshotRename     func() error
	BeforeManifestRename    func() error
	AfterManifestRename     func() error
	BeforeCurrentReplace    func() error
	AfterCurrentReplace     func() error
}

type Store struct {
	dir  string
	cfg  StoreConfig
	lock *storeLock

	state      *StateMachine
	height     uint64
	lastRecord []byte
	records    map[uint64][walDigestSize]byte

	wal        *os.File
	walSegment uint64
	walBytes   int64

	publishedHeight uint64
	lastReport      RecoveryReport
	closed          bool
	failed          error

	faults storeFaults
}

type storeFormat struct {
	ProjectID     string
	GenesisDigest [walDigestSize]byte
	ChainID       string
}

// OpenStore acquires the exclusive process lock, validates the on-disk format,
// loads the newest published generation, verifies the entire local WAL chain,
// and replays committed records that follow the loaded generation.
func OpenStore(dir string, cfg StoreConfig) (*Store, error) {
	if err := validateStoreConfig(cfg); err != nil {
		return nil, err
	}
	if cfg.MaxSegmentBytes == 0 {
		cfg.MaxSegmentBytes = DefaultMaxSegmentBytes
	}
	if cfg.MaxRecoveryBlocks == 0 {
		cfg.MaxRecoveryBlocks = DefaultMaxRecoveryBlocks
	}
	if cfg.MaxSegmentBytes < 1024 {
		return nil, fmt.Errorf("%w: segment bound is too small", ErrStoreBounds)
	}
	for _, sub := range []string{"", "wal", "snapshots", "generations"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o700); err != nil {
			return nil, err
		}
	}
	lock, err := acquireStoreLock(filepath.Join(dir, "LOCK"))
	if err != nil {
		return nil, err
	}
	s := &Store{dir: dir, cfg: cfg, lock: lock, records: make(map[uint64][walDigestSize]byte)}
	ok := false
	defer func() {
		if !ok {
			_ = s.Close()
		}
	}()
	if err := s.loadOrCreateFormat(); err != nil {
		return nil, err
	}
	report, err := s.recover()
	if err != nil {
		return nil, err
	}
	s.lastReport = report
	ok = true
	return s, nil
}

func validateStoreConfig(cfg StoreConfig) error {
	if cfg.ProjectID == "" || len(cfg.ProjectID) > maxProjectIDBytes {
		return fmt.Errorf("%w: invalid project ID", ErrStoreFormat)
	}
	if len(cfg.GenesisDigest) != sha256.Size {
		return fmt.Errorf("%w: genesis digest must be %d bytes", ErrStoreFormat, sha256.Size)
	}
	if isZeroDigestBytes(cfg.GenesisDigest) {
		return fmt.Errorf("%w: genesis digest must be nonzero", ErrStoreFormat)
	}
	if cfg.ChainID == "" || len(cfg.ChainID) > types.MaxChainIDLen {
		return fmt.Errorf("%w: invalid chain ID", ErrStoreFormat)
	}
	if cfg.MaxRecoveryBlocks < 0 {
		return fmt.Errorf("%w: negative recovery bound", ErrStoreBounds)
	}
	return nil
}

func (s *Store) loadOrCreateFormat() error {
	path := filepath.Join(s.dir, "FORMAT")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		encoded, err := encodeStoreFormat(storeFormat{
			ProjectID:     s.cfg.ProjectID,
			GenesisDigest: toDigest(s.cfg.GenesisDigest),
			ChainID:       s.cfg.ChainID,
		})
		if err != nil {
			return err
		}
		if err := createFileDurable(path, encoded); err != nil {
			if errors.Is(err, os.ErrExist) {
				// Another process won the race before our lock; re-read.
				return s.loadOrCreateFormat()
			}
			return err
		}
		return syncDirectory(s.dir)
	}
	if err != nil {
		return err
	}
	format, err := decodeStoreFormat(raw)
	if err != nil {
		return err
	}
	if format.ProjectID != s.cfg.ProjectID ||
		!bytes.Equal(format.GenesisDigest[:], s.cfg.GenesisDigest) ||
		format.ChainID != s.cfg.ChainID {
		return fmt.Errorf("%w: store is bound to a different project, genesis or chain", ErrStoreFormat)
	}
	return nil
}

// Height returns the last durably recorded block height.
func (s *Store) Height() uint64 { return s.height }

// State returns an independent copy of the current committed state.
func (s *Store) State() *StateMachine {
	if s == nil || s.state == nil {
		return nil
	}
	return s.state.Clone()
}

// AppHash returns the current committed application hash.
func (s *Store) AppHash() []byte {
	if s == nil || s.state == nil {
		return nil
	}
	return s.state.AppHash()
}

// AppendBlock verifies, durably appends and then adopts one committed block.
// The caller must have independently verified the block's commit evidence and
// recorded a reference digest for it. An identical already-committed block is
// idempotent and reports applied=false; any different block at or below the
// current height is a conflict.
func (s *Store) AppendBlock(record WALBlockRecord) (bool, error) {
	if err := s.ready(); err != nil {
		return false, err
	}
	if record.Height == 0 {
		return false, fmt.Errorf("%w: height must be nonzero", ErrInvalidBlockWALRecord)
	}
	if record.RecordNumber != 0 && record.RecordNumber != record.Height {
		return false, fmt.Errorf("%w: record number must equal the block height", ErrBlockWALLink)
	}
	record.RecordNumber = record.Height
	if err := s.normalizeRecord(&record); err != nil {
		return false, err
	}
	// Derive the canonical data hash before computing the block identity so an
	// idempotent retry is recognised even when the caller omitted the hash.
	derived, err := hashedTransactionData(record.Transactions)
	if err != nil {
		return false, err
	}
	derivedHash := toDigest(derived)
	if record.BlockDataHash != ([walDigestSize]byte{}) && record.BlockDataHash != derivedHash {
		return false, ErrBlockWALDataHashMismatch
	}
	record.BlockDataHash = derivedHash
	identity := walBlockCommitIdentity(record)
	if record.Height <= s.height {
		known, ok := s.records[record.Height]
		if !ok || known != identity {
			return false, fmt.Errorf("%w: height %d", ErrStoreConflict, record.Height)
		}
		return false, nil
	}
	if record.Height != s.height+1 {
		return false, fmt.Errorf("%w: height %d is not the successor of %d", ErrBlockWALLink, record.Height, s.height)
	}
	// The candidate state is derived from the exact recorded transactions and
	// must reproduce the recorded post-block app hash before anything is durable.
	candidate := s.state.Clone()
	if err := candidate.Replay(record.Transactions); err != nil {
		return false, fmt.Errorf("replay block %d: %w", record.Height, err)
	}
	if !bytes.Equal(candidate.AppHash(), record.PostBlockAppHash[:]) {
		return false, fmt.Errorf("%w: height %d", ErrStoreStateMismatch, record.Height)
	}
	// The local chain link is owned by the store, not by the caller.
	record.PreviousDigest = [walDigestSize]byte{}
	if s.lastRecord != nil {
		record.PreviousDigest = sha256.Sum256(s.lastRecord)
	}
	frame, err := EncodeWALBlockRecord(record)
	if err != nil {
		return false, err
	}
	if err := s.appendFrame(frame); err != nil {
		return false, err
	}
	// Only after the append is durable does the transition become current.
	s.state = candidate
	s.height = record.Height
	s.lastRecord = frame
	s.records[record.Height] = identity
	return true, nil
}

// normalizeRecord fills store-owned identity fields and rejects a record bound
// to another project, genesis or chain.
func (s *Store) normalizeRecord(record *WALBlockRecord) error {
	if record.ProjectID == "" {
		record.ProjectID = s.cfg.ProjectID
	}
	if record.ProjectID != s.cfg.ProjectID {
		return fmt.Errorf("%w: record belongs to another project", ErrStoreFormat)
	}
	if record.ChainID == "" {
		record.ChainID = s.cfg.ChainID
	}
	if record.ChainID != s.cfg.ChainID {
		return fmt.Errorf("%w: record belongs to another chain", ErrStoreFormat)
	}
	if record.GenesisDigest == ([walDigestSize]byte{}) {
		record.GenesisDigest = toDigest(s.cfg.GenesisDigest)
	}
	if record.GenesisDigest != toDigest(s.cfg.GenesisDigest) {
		return fmt.Errorf("%w: record belongs to another genesis", ErrStoreFormat)
	}
	if len(record.BlockID.Hash) == 0 || record.BlockID.PartSetHeader.Total == 0 {
		return ErrBlockWALBlockIDMismatch
	}
	return nil
}

func (s *Store) appendFrame(frame []byte) error {
	if len(frame)+4 > MaxBlockWALRecordBytes+4 {
		return ErrBlockWALRecordBounds
	}
	if s.faults.BeforeWALWrite != nil {
		if err := s.faults.BeforeWALWrite(); err != nil {
			return fmt.Errorf("%w: %v", ErrStoreFailed, err)
		}
	}
	if s.wal == nil || (s.walBytes > 0 && s.walBytes+int64(len(frame)+4) > s.cfg.MaxSegmentBytes) {
		if err := s.rotateSegment(); err != nil {
			return err
		}
	}
	offset := s.walBytes
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(frame)))
	if _, err := s.wal.Write(append(header, frame...)); err != nil {
		s.failClosed(err)
		s.rollbackAppend(offset)
		return err
	}
	if s.faults.AfterWALWriteBeforeSync != nil {
		if err := s.faults.AfterWALWriteBeforeSync(); err != nil {
			s.failClosed(err)
			s.rollbackAppend(offset)
			return fmt.Errorf("%w: %v", ErrStoreFailed, err)
		}
	}
	if err := s.wal.Sync(); err != nil {
		s.failClosed(err)
		s.rollbackAppend(offset)
		return fmt.Errorf("sync WAL segment: %w", err)
	}
	s.walBytes = offset + int64(len(frame)+4)
	if s.faults.AfterWALSync != nil {
		if err := s.faults.AfterWALSync(); err != nil {
			// The record is durable; the store must not pretend otherwise.
			s.failClosed(err)
			return fmt.Errorf("%w: %v", ErrStoreFailed, err)
		}
	}
	return nil
}

func (s *Store) rollbackAppend(offset int64) {
	if s.wal == nil {
		return
	}
	if err := s.wal.Truncate(offset); err != nil {
		return
	}
	s.walBytes = offset
}

func (s *Store) rotateSegment() error {
	if s.wal != nil {
		if err := s.wal.Sync(); err != nil {
			s.failClosed(err)
			return err
		}
		if err := s.wal.Close(); err != nil {
			s.failClosed(err)
			return err
		}
		s.wal = nil
	}
	next := s.walSegment + 1
	path := filepath.Join(s.dir, "wal", formatSegmentName(next))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		s.failClosed(err)
		return err
	}
	if err := syncDirectory(filepath.Join(s.dir, "wal")); err != nil {
		_ = file.Close()
		s.failClosed(err)
		return err
	}
	s.wal = file
	s.walSegment = next
	s.walBytes = 0
	return nil
}

func (s *Store) failClosed(err error) {
	if s.failed == nil {
		s.failed = err
	}
}

func (s *Store) ready() error {
	if s == nil {
		return ErrStoreClosed
	}
	if s.closed {
		return ErrStoreClosed
	}
	if s.failed != nil {
		return fmt.Errorf("%w: %v", ErrStoreFailed, s.failed)
	}
	return nil
}

// Close flushes and releases the store. It never discards unflushed data
// silently: a failed sync is reported to the caller.
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	if s.closed {
		return nil
	}
	s.closed = true
	var firstErr error
	if s.wal != nil {
		if err := s.wal.Sync(); err != nil && firstErr == nil {
			firstErr = err
		}
		if err := s.wal.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		s.wal = nil
	}
	if s.lock != nil {
		if err := s.lock.release(); err != nil && firstErr == nil {
			firstErr = err
		}
		s.lock = nil
	}
	return firstErr
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

type storeGeneration struct {
	Height              uint64
	BlockIDHash         [walDigestSize]byte
	BlockIDPartSetTotal uint32
	BlockIDPartSetHash  [walDigestSize]byte
	PostBlockAppHash    [walDigestSize]byte
	SnapshotDigest      [walDigestSize]byte
	SnapshotSize        uint64
	WALRecordDigest     [walDigestSize]byte
}

type storeCurrent struct {
	Height         uint64
	ManifestDigest [walDigestSize]byte
}

func (s *Store) recover() (RecoveryReport, error) {
	report := RecoveryReport{}
	s.state = nil
	s.height = 0
	s.lastRecord = nil
	s.records = make(map[uint64][walDigestSize]byte)

	generation, hasGeneration, err := s.loadPublishedGeneration(&report)
	if err != nil {
		return report, err
	}
	if hasGeneration {
		report.SnapshotHeight = generation.Height
	}
	if s.state == nil {
		state, err := NewStateMachine(s.cfg.ProjectID, s.cfg.GenesisDigest)
		if err != nil {
			return report, err
		}
		s.state = state
	}

	segments, err := s.listSegments()
	if err != nil {
		return report, err
	}
	report.SegmentsScanned = len(segments)
	lastHeight, truncated, err := s.scanSegments(segments, hasGeneration, generation)
	if err != nil {
		return report, err
	}
	report.TruncatedTailBytes = truncated
	if hasGeneration && lastHeight < generation.Height {
		return report, fmt.Errorf("%w: published generation is at height %d but the WAL ends at %d",
			ErrStoreRollback, generation.Height, lastHeight)
	}
	report.ReplayedBlocks = int(s.height - report.SnapshotHeight)
	report.Height = s.height
	return report, nil
}

func (s *Store) listSegments() ([]uint64, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, "wal"))
	if err != nil {
		return nil, err
	}
	var segments []uint64
	for _, entry := range entries {
		if entry.IsDir() {
			return nil, fmt.Errorf("%w: unexpected directory in wal", ErrStoreCorrupt)
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".tmp") {
			continue
		}
		if !strings.HasPrefix(name, "segment-") || !strings.HasSuffix(name, ".log") {
			return nil, fmt.Errorf("%w: unexpected WAL entry %q", ErrStoreCorrupt, name)
		}
		number, err := strconv.ParseUint(strings.TrimSuffix(strings.TrimPrefix(name, "segment-"), ".log"), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: unparsable WAL segment %q", ErrStoreCorrupt, name)
		}
		segments = append(segments, number)
	}
	for i := 1; i < len(segments); i++ {
		if segments[i] != segments[i-1]+1 {
			return nil, fmt.Errorf("%w: WAL segment gap between %d and %d", ErrStoreCorrupt, segments[i-1], segments[i])
		}
	}
	if len(segments) > 0 && segments[0] != 1 {
		return nil, fmt.Errorf("%w: WAL does not start at segment 1", ErrStoreCorrupt)
	}
	return segments, nil
}

// scanSegments verifies the complete local record chain and replays records
// after the published generation. It returns the last verified height and any
// discarded torn-tail byte count.
func (s *Store) scanSegments(segments []uint64, hasGeneration bool, generation storeGeneration) (uint64, int64, error) {
	var previous []byte
	var truncated int64
	expectedNumber := uint64(1)
	snapshotHeight := uint64(0)
	if hasGeneration {
		snapshotHeight = generation.Height
	}
	verified := 0
	for index, segment := range segments {
		path := filepath.Join(s.dir, "wal", formatSegmentName(segment))
		data, err := os.ReadFile(path)
		if err != nil {
			return 0, 0, err
		}
		if int64(len(data)) > s.cfg.MaxSegmentBytes {
			return 0, 0, fmt.Errorf("%w: WAL segment %d exceeds the configured bound", ErrStoreBounds, segment)
		}
		last := index == len(segments)-1
		offset := 0
		for offset < len(data) {
			remaining := len(data) - offset
			if remaining < 4 {
				if !last {
					return 0, 0, fmt.Errorf("%w: torn frame header in non-final WAL segment %d", ErrStoreCorrupt, segment)
				}
				truncated = int64(remaining)
				if err := os.Truncate(path, int64(offset)); err != nil {
					return 0, 0, err
				}
				break
			}
			length := int(binary.BigEndian.Uint32(data[offset:]))
			if length <= 0 || length > MaxBlockWALRecordBytes {
				return 0, 0, fmt.Errorf("%w: invalid frame length %d in segment %d at offset %d",
					ErrStoreCorrupt, length, segment, offset)
			}
			if remaining-4 < length {
				if !last {
					return 0, 0, fmt.Errorf("%w: truncated frame in non-final WAL segment %d", ErrStoreCorrupt, segment)
				}
				// A final frame shorter than its declared length is an
				// uncommitted suffix: the store never treats an append that was
				// not synced as durable. A frame whose declared length is fully
				// present but whose checksum fails is corruption, not a tail.
				truncated = int64(remaining)
				if err := os.Truncate(path, int64(offset)); err != nil {
					return 0, 0, err
				}
				break
			}
			frame := data[offset+4 : offset+4+length]
			record, err := DecodeWALBlockRecord(frame)
			if err != nil {
				return 0, 0, fmt.Errorf("%w: segment %d offset %d: %v", ErrStoreCorrupt, segment, offset, err)
			}
			if record.RecordNumber != expectedNumber || record.Height != expectedNumber {
				return 0, 0, fmt.Errorf("%w: expected record/height %d, found %d/%d",
					ErrStoreCorrupt, expectedNumber, record.RecordNumber, record.Height)
			}
			if record.ProjectID != s.cfg.ProjectID ||
				!bytes.Equal(record.GenesisDigest[:], s.cfg.GenesisDigest) ||
				record.ChainID != s.cfg.ChainID {
				return 0, 0, fmt.Errorf("%w: record %d is bound to another project, genesis or chain", ErrStoreFormat, record.RecordNumber)
			}
			if previous != nil {
				if err := VerifyWALBlockRecordLink(previous, frame); err != nil {
					return 0, 0, fmt.Errorf("%w: %v", ErrStoreCorrupt, err)
				}
			} else if !isZeroWALHash(record.PreviousDigest) {
				return 0, 0, fmt.Errorf("%w: first record has a predecessor digest", ErrStoreCorrupt)
			}
			if hasGeneration && record.Height == generation.Height {
				if err := verifyGenerationRecord(generation, record, frame); err != nil {
					return 0, 0, err
				}
			}
			if record.Height > snapshotHeight {
				if err := s.state.Replay(record.Transactions); err != nil {
					return 0, 0, fmt.Errorf("%w: replay record %d: %v", ErrStoreCorrupt, record.Height, err)
				}
				if !bytes.Equal(s.state.AppHash(), record.PostBlockAppHash[:]) {
					return 0, 0, fmt.Errorf("%w: record %d replayed to a different app hash", ErrStoreStateMismatch, record.Height)
				}
				s.height = record.Height
			}
			s.records[record.Height] = walBlockCommitIdentity(record)
			previous = append([]byte(nil), frame...)
			expectedNumber++
			offset += 4 + length
			verified++
			if verified > s.cfg.MaxRecoveryBlocks {
				return 0, 0, fmt.Errorf("%w: WAL holds more than %d records", ErrStoreBounds, s.cfg.MaxRecoveryBlocks)
			}
		}
	}
	if previous == nil {
		return 0, truncated, nil
	}
	lastRecord, err := DecodeWALBlockRecord(previous)
	if err != nil {
		return 0, 0, err
	}
	s.lastRecord = previous
	if s.wal == nil {
		lastSegment := segments[len(segments)-1]
		data, err := os.Stat(filepath.Join(s.dir, "wal", formatSegmentName(lastSegment)))
		if err != nil {
			return 0, 0, err
		}
		if err := s.openSegmentForAppend(lastSegment, data.Size()); err != nil {
			return 0, 0, err
		}
	}
	return lastRecord.Height, truncated, nil
}

// openSegmentForAppend reopens an existing segment so appends continue in it.
func (s *Store) openSegmentForAppend(number uint64, size int64) error {
	file, err := os.OpenFile(filepath.Join(s.dir, "wal", formatSegmentName(number)), os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	s.wal = file
	s.walSegment = number
	s.walBytes = size
	return nil
}

func verifyGenerationRecord(generation storeGeneration, record WALBlockRecord, frame []byte) error {
	if record.Height != generation.Height {
		return fmt.Errorf("%w: generation height does not match its WAL record", ErrStoreRollback)
	}
	digest := sha256.Sum256(frame)
	if digest != generation.WALRecordDigest {
		return fmt.Errorf("%w: generation references a different WAL record digest", ErrStoreRollback)
	}
	if !bytes.Equal(record.BlockID.Hash, generation.BlockIDHash[:]) ||
		record.BlockID.PartSetHeader.Total != generation.BlockIDPartSetTotal ||
		!bytes.Equal(record.BlockID.PartSetHeader.Hash, generation.BlockIDPartSetHash[:]) {
		return fmt.Errorf("%w: generation block ID does not match its WAL record", ErrStoreRollback)
	}
	if generation.PostBlockAppHash != record.PostBlockAppHash {
		return fmt.Errorf("%w: generation app hash does not match its WAL record", ErrStoreRollback)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Generation publication
// ---------------------------------------------------------------------------

// PublishGeneration writes a new state snapshot generation and atomically makes
// it current. Each file is written to a synced temporary file and published by
// rename, the snapshot before its manifest, and the manifest before CURRENT, so
// a crash leaves either the previous complete generation or the next complete
// generation visible, never a partial one.
func (s *Store) PublishGeneration() error {
	if err := s.ready(); err != nil {
		return err
	}
	if s.height == 0 || s.lastRecord == nil {
		return ErrStoreNotDurableHeight
	}
	if s.publishedHeight >= s.height {
		return nil
	}
	record, err := DecodeWALBlockRecord(s.lastRecord)
	if err != nil {
		return err
	}
	snapshot, err := s.state.EncodeSnapshot()
	if err != nil {
		return err
	}
	snapshotDigest := sha256.Sum256(snapshot)
	walDigest := sha256.Sum256(s.lastRecord)
	generation := storeGeneration{
		Height:              record.Height,
		BlockIDPartSetTotal: uint32(record.BlockID.PartSetHeader.Total),
		PostBlockAppHash:    record.PostBlockAppHash,
		SnapshotDigest:      snapshotDigest,
		SnapshotSize:        uint64(len(snapshot)),
		WALRecordDigest:     walDigest,
	}
	copy(generation.BlockIDHash[:], record.BlockID.Hash)
	copy(generation.BlockIDPartSetHash[:], record.BlockID.PartSetHeader.Hash)
	manifest, err := encodeStoreManifest(s.cfg, generation)
	if err != nil {
		return err
	}
	current, err := encodeStoreCurrent(storeCurrent{
		Height:         generation.Height,
		ManifestDigest: sha256.Sum256(manifest),
	})
	if err != nil {
		return err
	}

	snapshotPath := filepath.Join(s.dir, "snapshots", formatGenerationName(generation.Height)+".zst")
	manifestPath := filepath.Join(s.dir, "generations", formatGenerationName(generation.Height)+".manifest")

	if err := publishFileDurable(snapshotPath, snapshot, fileFaults{
		BeforeWrite:  s.faults.BeforeSnapshotWrite,
		AfterSync:    s.faults.AfterSnapshotSync,
		BeforeRename: s.faults.BeforeSnapshotRename,
		AfterRename:  s.faults.AfterSnapshotRename,
	}); err != nil {
		return err
	}
	if err := publishFileDurable(manifestPath, manifest, fileFaults{
		BeforeRename: s.faults.BeforeManifestRename,
		AfterRename:  s.faults.AfterManifestRename,
	}); err != nil {
		return err
	}
	if err := publishFileDurable(filepath.Join(s.dir, "CURRENT"), current, fileFaults{
		BeforeRename: s.faults.BeforeCurrentReplace,
		AfterRename:  s.faults.AfterCurrentReplace,
	}); err != nil {
		return err
	}
	s.publishedHeight = generation.Height
	return nil
}

func (s *Store) loadPublishedGeneration(report *RecoveryReport) (storeGeneration, bool, error) {
	var generation storeGeneration
	currentRaw, err := os.ReadFile(filepath.Join(s.dir, "CURRENT"))
	if errors.Is(err, os.ErrNotExist) {
		return generation, false, nil
	}
	if err != nil {
		return generation, false, err
	}
	current, err := decodeStoreCurrent(currentRaw)
	if err != nil {
		return generation, false, err
	}
	manifestPath := filepath.Join(s.dir, "generations", formatGenerationName(current.Height)+".manifest")
	manifestRaw, err := os.ReadFile(manifestPath)
	if err != nil {
		return generation, false, fmt.Errorf("%w: published generation manifest is missing: %v", ErrStoreCorrupt, err)
	}
	if sum := sha256.Sum256(manifestRaw); sum != current.ManifestDigest {
		return generation, false, fmt.Errorf("%w: CURRENT digest does not match its manifest", ErrStoreCorrupt)
	}
	generation, err = decodeStoreManifest(manifestRaw, s.cfg)
	if err != nil {
		return generation, false, err
	}
	if generation.Height != current.Height {
		return generation, false, fmt.Errorf("%w: CURRENT height disagrees with its manifest", ErrStoreCorrupt)
	}
	snapshotPath := filepath.Join(s.dir, "snapshots", formatGenerationName(generation.Height)+".zst")
	snapshot, err := os.ReadFile(snapshotPath)
	if err != nil {
		return generation, false, fmt.Errorf("%w: published snapshot is missing: %v", ErrStoreCorrupt, err)
	}
	if uint64(len(snapshot)) != generation.SnapshotSize {
		return generation, false, fmt.Errorf("%w: published snapshot size mismatch", ErrStoreCorrupt)
	}
	if sum := sha256.Sum256(snapshot); sum != generation.SnapshotDigest {
		return generation, false, fmt.Errorf("%w: published snapshot digest mismatch", ErrStoreCorrupt)
	}
	state, err := DecodeStateSnapshot(snapshot, s.cfg.ProjectID, s.cfg.GenesisDigest)
	if err != nil {
		return generation, false, fmt.Errorf("%w: decode published snapshot: %v", ErrStoreCorrupt, err)
	}
	if !bytes.Equal(state.AppHash(), generation.PostBlockAppHash[:]) {
		return generation, false, fmt.Errorf("%w: published snapshot app hash does not match its manifest", ErrStoreCorrupt)
	}
	s.state = state
	s.height = generation.Height
	s.publishedHeight = generation.Height
	report.Height = generation.Height
	return generation, true, nil
}

// ---------------------------------------------------------------------------
// Durable file helpers
// ---------------------------------------------------------------------------

// createFileDurable creates path exclusively, writes data, and syncs it.
func createFileDurable(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

// fileFaults models the durability boundaries of a single published file.
type fileFaults struct {
	BeforeWrite  func() error
	AfterSync    func() error
	BeforeRename func() error
	AfterRename  func() error
}

func (f fileFaults) check(hook func() error) error {
	if hook == nil {
		return nil
	}
	if err := hook(); err != nil {
		return fmt.Errorf("%w: %v", ErrStoreFailed, err)
	}
	return nil
}

// publishFileDurable writes data through a synced temporary file and publishes
// it with an atomic rename, then syncs the containing directory where supported.
func publishFileDurable(path string, data []byte, faults fileFaults) error {
	dir := filepath.Dir(path)
	if err := faults.check(faults.BeforeWrite); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := faults.check(faults.AfterSync); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := faults.check(faults.BeforeRename); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := faults.check(faults.AfterRename); err != nil {
		return err
	}
	return syncDirectory(dir)
}

// syncDirectory flushes directory metadata where the platform supports it.
// Windows has no portable directory fsync through os.File; the limitation is
// documented in the spec and covered by platform-specific tests.
func syncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync directory %s: %w", path, err)
	}
	return nil
}

func formatSegmentName(number uint64) string {
	return fmt.Sprintf("segment-%020d.log", number)
}

func formatGenerationName(height uint64) string {
	return fmt.Sprintf("generation-%020d", height)
}

func toDigest(value []byte) [walDigestSize]byte {
	var out [walDigestSize]byte
	copy(out[:], value)
	return out
}

// walBlockCommitIdentity digests the semantic identity of one committed block
// transition. It deliberately excludes the local record number and the
// previous-record link so an idempotent retry of an already recorded block is
// recognised regardless of how the caller populated local chain fields.
func walBlockCommitIdentity(record WALBlockRecord) [walDigestSize]byte {
	var buffer bytes.Buffer
	buffer.WriteString("ZION-POC-BLOCK-IDENTITY")
	writeLengthPrefixed(&buffer, []byte(record.ProjectID))
	buffer.Write(record.GenesisDigest[:])
	writeLengthPrefixed(&buffer, []byte(record.ChainID))
	var number [8]byte
	binary.BigEndian.PutUint64(number[:], record.Height)
	buffer.Write(number[:])
	var partTotal [4]byte
	binary.BigEndian.PutUint32(partTotal[:], record.BlockID.PartSetHeader.Total)
	buffer.Write(record.BlockID.Hash)
	buffer.Write(partTotal[:])
	buffer.Write(record.BlockID.PartSetHeader.Hash)
	buffer.Write(record.BlockDataHash[:])
	buffer.Write(record.PostBlockAppHash[:])
	buffer.Write(record.CommitEvidenceDigest[:])
	return sha256.Sum256(buffer.Bytes())
}

func writeLengthPrefixed(buffer *bytes.Buffer, value []byte) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	buffer.Write(length[:])
	buffer.Write(value)
}

// ---------------------------------------------------------------------------
// FORMAT, manifest and CURRENT codecs
// ---------------------------------------------------------------------------

func encodeStoreFormat(format storeFormat) ([]byte, error) {
	project := []byte(format.ProjectID)
	chainID := []byte(format.ChainID)
	if len(project) == 0 || len(project) > maxProjectIDBytes ||
		len(chainID) == 0 || len(chainID) > types.MaxChainIDLen ||
		isZeroWALHash(format.GenesisDigest) {
		return nil, ErrStoreFormat
	}
	out := make([]byte, 0, 4+2+2+len(project)+walDigestSize+2+len(chainID)+walDigestSize)
	out = append(out, storeFormatMagic...)
	out = appendUint16(out, storeFormatVersion)
	out = appendUint16(out, uint16(len(project)))
	out = append(out, project...)
	out = append(out, format.GenesisDigest[:]...)
	out = appendUint16(out, uint16(len(chainID)))
	out = append(out, chainID...)
	checksum := sha256.Sum256(out)
	return append(out, checksum[:]...), nil
}

func decodeStoreFormat(raw []byte) (storeFormat, error) {
	var format storeFormat
	if len(raw) < 4+2+2+1+walDigestSize+2+1+walDigestSize || len(raw) > 512 {
		return format, ErrStoreFormat
	}
	body, checksum := raw[:len(raw)-walDigestSize], raw[len(raw)-walDigestSize:]
	sum := sha256.Sum256(body)
	if !bytes.Equal(sum[:], checksum) {
		return format, fmt.Errorf("%w: FORMAT checksum mismatch", ErrStoreFormat)
	}
	r := bytes.NewReader(body)
	magic := make([]byte, 4)
	if _, err := r.Read(magic); err != nil || string(magic) != storeFormatMagic {
		return format, ErrStoreFormat
	}
	var version uint16
	if binary.Read(r, binary.BigEndian, &version) != nil || version != storeFormatVersion {
		return format, ErrStoreFormat
	}
	var projectLen uint16
	if binary.Read(r, binary.BigEndian, &projectLen) != nil || projectLen == 0 ||
		projectLen > maxProjectIDBytes || int(projectLen) > r.Len() {
		return format, ErrStoreFormat
	}
	project := make([]byte, projectLen)
	if _, err := r.Read(project); err != nil {
		return format, ErrStoreFormat
	}
	format.ProjectID = string(project)
	genesis := make([]byte, walDigestSize)
	if _, err := r.Read(genesis); err != nil {
		return format, ErrStoreFormat
	}
	copy(format.GenesisDigest[:], genesis)
	var chainIDLen uint16
	if binary.Read(r, binary.BigEndian, &chainIDLen) != nil || chainIDLen == 0 ||
		chainIDLen > types.MaxChainIDLen || int(chainIDLen) > r.Len() {
		return format, ErrStoreFormat
	}
	chainID := make([]byte, chainIDLen)
	if _, err := r.Read(chainID); err != nil {
		return format, ErrStoreFormat
	}
	format.ChainID = string(chainID)
	if r.Len() != 0 || isZeroWALHash(format.GenesisDigest) {
		return format, ErrStoreFormat
	}
	return format, nil
}

func encodeStoreManifest(cfg StoreConfig, generation storeGeneration) ([]byte, error) {
	project := []byte(cfg.ProjectID)
	chainID := []byte(cfg.ChainID)
	out := make([]byte, 0, len(storeManifestMagic)+2+2+len(project)+walDigestSize+2+len(chainID)+8+
		walDigestSize+4+walDigestSize+walDigestSize+walDigestSize+8+walDigestSize+walDigestSize)
	out = append(out, storeManifestMagic...)
	out = appendUint16(out, storeManifestVersion)
	out = appendUint16(out, uint16(len(project)))
	out = append(out, project...)
	out = append(out, cfg.GenesisDigest...)
	out = appendUint16(out, uint16(len(chainID)))
	out = append(out, chainID...)
	out = appendUint64(out, generation.Height)
	out = append(out, generation.BlockIDHash[:]...)
	out = appendUint32(out, generation.BlockIDPartSetTotal)
	out = append(out, generation.BlockIDPartSetHash[:]...)
	out = append(out, generation.PostBlockAppHash[:]...)
	out = append(out, generation.SnapshotDigest[:]...)
	out = appendUint64(out, generation.SnapshotSize)
	out = append(out, generation.WALRecordDigest[:]...)
	checksum := sha256.Sum256(out)
	return append(out, checksum[:]...), nil
}

func decodeStoreManifest(raw []byte, cfg StoreConfig) (storeGeneration, error) {
	var generation storeGeneration
	const minBytes = len(storeManifestMagic) + 2 + 2 + 1 + walDigestSize + 2 + 1 + 8 +
		walDigestSize + 4 + walDigestSize + walDigestSize + walDigestSize + 8 + walDigestSize + walDigestSize
	if len(raw) < minBytes || len(raw) > minBytes+maxProjectIDBytes+types.MaxChainIDLen {
		return generation, fmt.Errorf("%w: manifest length is out of bounds", ErrStoreCorrupt)
	}
	body, checksum := raw[:len(raw)-walDigestSize], raw[len(raw)-walDigestSize:]
	sum := sha256.Sum256(body)
	if !bytes.Equal(sum[:], checksum) {
		return generation, fmt.Errorf("%w: manifest checksum mismatch", ErrStoreCorrupt)
	}
	r := bytes.NewReader(body)
	magic := make([]byte, len(storeManifestMagic))
	if _, err := r.Read(magic); err != nil || string(magic) != storeManifestMagic {
		return generation, fmt.Errorf("%w: manifest magic mismatch", ErrStoreCorrupt)
	}
	var version uint16
	if binary.Read(r, binary.BigEndian, &version) != nil || version != storeManifestVersion {
		return generation, fmt.Errorf("%w: unsupported manifest version", ErrStoreCorrupt)
	}
	var projectLen uint16
	if binary.Read(r, binary.BigEndian, &projectLen) != nil || projectLen == 0 ||
		projectLen > maxProjectIDBytes || int(projectLen) > r.Len() {
		return generation, fmt.Errorf("%w: malformed manifest project", ErrStoreCorrupt)
	}
	project := make([]byte, projectLen)
	if _, err := r.Read(project); err != nil {
		return generation, fmt.Errorf("%w: truncated manifest project", ErrStoreCorrupt)
	}
	if string(project) != cfg.ProjectID {
		return generation, fmt.Errorf("%w: manifest belongs to another project", ErrStoreFormat)
	}
	genesis := make([]byte, walDigestSize)
	if _, err := r.Read(genesis); err != nil {
		return generation, fmt.Errorf("%w: truncated manifest genesis", ErrStoreCorrupt)
	}
	if !bytes.Equal(genesis, cfg.GenesisDigest) {
		return generation, fmt.Errorf("%w: manifest belongs to another genesis", ErrStoreFormat)
	}
	var chainIDLen uint16
	if binary.Read(r, binary.BigEndian, &chainIDLen) != nil || chainIDLen == 0 ||
		chainIDLen > types.MaxChainIDLen || int(chainIDLen) > r.Len() {
		return generation, fmt.Errorf("%w: malformed manifest chain ID", ErrStoreCorrupt)
	}
	chainID := make([]byte, chainIDLen)
	if _, err := r.Read(chainID); err != nil {
		return generation, fmt.Errorf("%w: truncated manifest chain ID", ErrStoreCorrupt)
	}
	if string(chainID) != cfg.ChainID {
		return generation, fmt.Errorf("%w: manifest belongs to another chain", ErrStoreFormat)
	}
	readInto := func(target []byte) error {
		if _, err := r.Read(target); err != nil {
			return fmt.Errorf("%w: truncated manifest field", ErrStoreCorrupt)
		}
		return nil
	}
	if binary.Read(r, binary.BigEndian, &generation.Height) != nil {
		return generation, fmt.Errorf("%w: truncated manifest height", ErrStoreCorrupt)
	}
	if err := readInto(generation.BlockIDHash[:]); err != nil {
		return generation, err
	}
	if binary.Read(r, binary.BigEndian, &generation.BlockIDPartSetTotal) != nil {
		return generation, fmt.Errorf("%w: truncated manifest part-set total", ErrStoreCorrupt)
	}
	if err := readInto(generation.BlockIDPartSetHash[:]); err != nil {
		return generation, err
	}
	if err := readInto(generation.PostBlockAppHash[:]); err != nil {
		return generation, err
	}
	if err := readInto(generation.SnapshotDigest[:]); err != nil {
		return generation, err
	}
	if binary.Read(r, binary.BigEndian, &generation.SnapshotSize) != nil {
		return generation, fmt.Errorf("%w: truncated manifest snapshot size", ErrStoreCorrupt)
	}
	if err := readInto(generation.WALRecordDigest[:]); err != nil {
		return generation, err
	}
	if r.Len() != 0 {
		return generation, fmt.Errorf("%w: trailing manifest bytes", ErrStoreCorrupt)
	}
	if generation.Height == 0 || generation.BlockIDPartSetTotal == 0 ||
		isZeroWALHash(generation.BlockIDHash) || isZeroWALHash(generation.PostBlockAppHash) ||
		isZeroWALHash(generation.SnapshotDigest) || isZeroWALHash(generation.WALRecordDigest) {
		return generation, fmt.Errorf("%w: incomplete manifest", ErrStoreCorrupt)
	}
	return generation, nil
}

func encodeStoreCurrent(current storeCurrent) ([]byte, error) {
	if current.Height == 0 {
		return nil, ErrStoreCorrupt
	}
	line := fmt.Sprintf("%s %d %x\n", storeCurrentMagic, current.Height, current.ManifestDigest[:])
	return []byte(line), nil
}

func decodeStoreCurrent(raw []byte) (storeCurrent, error) {
	var current storeCurrent
	if len(raw) == 0 || len(raw) > 256 {
		return current, fmt.Errorf("%w: CURRENT length is out of bounds", ErrStoreCorrupt)
	}
	fields := strings.Fields(string(raw))
	if len(fields) != 3 || fields[0] != storeCurrentMagic {
		return current, fmt.Errorf("%w: malformed CURRENT pointer", ErrStoreCorrupt)
	}
	height, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil || height == 0 {
		return current, fmt.Errorf("%w: malformed CURRENT height", ErrStoreCorrupt)
	}
	digest, err := decodeFixedHex(fields[2], walDigestSize)
	if err != nil {
		return current, fmt.Errorf("%w: malformed CURRENT digest", ErrStoreCorrupt)
	}
	current.Height = height
	current.ManifestDigest = digest
	return current, nil
}

func decodeFixedHex(value string, size int) ([walDigestSize]byte, error) {
	var out [walDigestSize]byte
	if len(value) != size*2 || size > walDigestSize {
		return out, errors.New("unexpected hex digest length")
	}
	for i := 0; i < size; i++ {
		high, err := hexDigit(value[i*2])
		if err != nil {
			return out, err
		}
		low, err := hexDigit(value[i*2+1])
		if err != nil {
			return out, err
		}
		out[i] = high<<4 | low
	}
	return out, nil
}

func hexDigit(value byte) (byte, error) {
	switch {
	case value >= '0' && value <= '9':
		return value - '0', nil
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10, nil
	case value >= 'A' && value <= 'F':
		return value - 'A' + 10, nil
	}
	return 0, errors.New("invalid hex digit")
}
