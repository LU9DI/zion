package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/cometbft/cometbft/crypto/tmhash"
	"github.com/cometbft/cometbft/types"
)

// This file defines ZWB1, the block-atomic WAL envelope required before any
// filesystem persistence. A ZWB1 record describes one complete committed
// CometBFT block: its identity, every exact ordered transaction byte string,
// the canonical data hash recomputed from those bytes, the expected post-block
// application hash, and a reference digest to independently verified commit
// evidence.
//
// The codec is still codec-only. It authenticates nothing: the commit evidence
// digest is a lookup/binding aid, the checksum detects accidental damage only,
// and a valid record does not prove that consensus committed the block.

const (
	blockWALRecordVersion = uint16(1)
	blockWALRecordMagic   = "ZWB1"

	// blockWALFixedBytes is every byte of a ZWB1 frame except the two
	// variable-length strings and the transaction payload list:
	// magic(4) + version(2) + frame length(4) + record number(8) +
	// project length(2) + genesis(32) + chain ID length(2) + height(8) +
	// block hash(32) + part-set total(4) + part-set hash(32) +
	// evidence digest(32) + transaction count(4) + data hash(32) +
	// post-block app hash(32) + previous digest(32) + checksum(32).
	blockWALFixedBytes = 4 + 2 + 4 + 8 + 2 + walDigestSize + 2 + 8 +
		walDigestSize + 4 + walDigestSize + walDigestSize + 4 +
		walDigestSize + walDigestSize + walDigestSize + walDigestSize

	// MaxBlockWALRecordBytes bounds a single block frame: the block data bound
	// plus the four length bytes each transaction needs plus fixed overhead.
	MaxBlockWALRecordBytes = MaxBlockDataBytes +
		4*MaxTransactionsPerBlock + blockWALFixedBytes + 256
)

var (
	ErrInvalidBlockWALRecord    = errors.New("invalid canonical block WAL record")
	ErrBlockWALRecordBounds     = errors.New("block WAL record exceeds configured bounds")
	ErrBlockWALChecksum         = errors.New("block WAL record checksum mismatch")
	ErrBlockWALDataHashMismatch = errors.New("block WAL record data hash does not match its transactions")
	ErrBlockWALLink             = errors.New("block WAL record chain link mismatch")
	ErrBlockWALHeightRegression = errors.New("block WAL record height is not strictly increasing")
	ErrBlockWALBlockIDMismatch  = errors.New("block WAL record block ID is incomplete or malformed")
)

// WALBlockRecord is one complete committed block as recorded in the local
// write-ahead log. Transactions must be the exact ordered block payload: the
// canonical data hash is recomputed from them and never trusted from the caller.
type WALBlockRecord struct {
	RecordNumber     uint64
	ProjectID        string
	GenesisDigest    [walDigestSize]byte
	ChainID          string
	Height           uint64
	BlockID          types.BlockID
	Transactions     [][]byte
	BlockDataHash    [walDigestSize]byte
	PostBlockAppHash [walDigestSize]byte
	// CommitEvidenceDigest binds the retained, independently verified commit
	// evidence for this block. It is not itself a trust anchor.
	CommitEvidenceDigest [walDigestSize]byte
	PreviousDigest       [walDigestSize]byte
}

// EncodeWALBlockRecord emits the canonical ZWB1 v1 frame. BlockDataHash is
// derived from Transactions; a caller-supplied non-zero value must agree with
// the derived value or encoding fails closed.
func EncodeWALBlockRecord(record WALBlockRecord) ([]byte, error) {
	dataHash, err := hashedTransactionData(record.Transactions)
	if err != nil {
		return nil, err
	}
	var derived [walDigestSize]byte
	copy(derived[:], dataHash)
	if record.BlockDataHash != ([walDigestSize]byte{}) && record.BlockDataHash != derived {
		return nil, ErrBlockWALDataHashMismatch
	}
	record.BlockDataHash = derived
	if err := validateWALBlockRecordFields(record); err != nil {
		return nil, err
	}

	project := []byte(record.ProjectID)
	chainID := []byte(record.ChainID)
	total := uint64(blockWALFixedBytes) + uint64(len(project)) + uint64(len(chainID))
	for _, tx := range record.Transactions {
		total += 4 + uint64(len(tx))
	}
	if total > MaxBlockWALRecordBytes || total > uint64(^uint32(0)) {
		return nil, ErrBlockWALRecordBounds
	}

	out := make([]byte, 0, int(total))
	out = append(out, blockWALRecordMagic...)
	out = appendUint16(out, blockWALRecordVersion)
	out = appendUint32(out, uint32(total))
	out = appendUint64(out, record.RecordNumber)
	out = appendUint16(out, uint16(len(project)))
	out = append(out, project...)
	out = append(out, record.GenesisDigest[:]...)
	out = appendUint16(out, uint16(len(chainID)))
	out = append(out, chainID...)
	out = appendUint64(out, record.Height)
	out = append(out, record.BlockID.Hash...)
	out = appendUint32(out, record.BlockID.PartSetHeader.Total)
	out = append(out, record.BlockID.PartSetHeader.Hash...)
	out = append(out, record.CommitEvidenceDigest[:]...)
	out = appendUint32(out, uint32(len(record.Transactions)))
	for _, tx := range record.Transactions {
		out = appendUint32(out, uint32(len(tx)))
		out = append(out, tx...)
	}
	out = append(out, record.BlockDataHash[:]...)
	out = append(out, record.PostBlockAppHash[:]...)
	out = append(out, record.PreviousDigest[:]...)
	if len(out) != int(total)-walDigestSize {
		// Defensive: the header arithmetic and the written bytes must agree
		// before a checksum is computed over the frame.
		return nil, ErrInvalidBlockWALRecord
	}
	checksum := sha256.Sum256(out)
	out = append(out, checksum[:]...)
	return out, nil
}

// DecodeWALBlockRecord strictly decodes one complete canonical ZWB1 v1 frame.
// It rejects truncation, trailing bytes, unknown versions, invalid or oversized
// fields, a transaction count that disagrees with the encoded list, and a data
// hash that does not match the transaction bytes it covers.
func DecodeWALBlockRecord(raw []byte) (WALBlockRecord, error) {
	var record WALBlockRecord
	if len(raw) < blockWALFixedBytes+1 {
		return record, ErrInvalidBlockWALRecord
	}
	if len(raw) > MaxBlockWALRecordBytes {
		return record, ErrBlockWALRecordBounds
	}
	if string(raw[:4]) != blockWALRecordMagic {
		return record, ErrInvalidBlockWALRecord
	}
	if binary.BigEndian.Uint16(raw[4:6]) != blockWALRecordVersion {
		return record, ErrInvalidBlockWALRecord
	}
	if uint64(binary.BigEndian.Uint32(raw[6:10])) != uint64(len(raw)) {
		return record, ErrInvalidBlockWALRecord
	}
	checksumOffset := len(raw) - walDigestSize
	expectedChecksum := sha256.Sum256(raw[:checksumOffset])
	if !bytes.Equal(expectedChecksum[:], raw[checksumOffset:]) {
		return record, ErrBlockWALChecksum
	}

	offset := 10
	readBytes := func(n int) ([]byte, error) {
		if n < 0 || checksumOffset-offset < n {
			return nil, ErrInvalidBlockWALRecord
		}
		value := raw[offset : offset+n]
		offset += n
		return value, nil
	}
	readUint32 := func() (uint32, error) {
		value, err := readBytes(4)
		if err != nil {
			return 0, err
		}
		return binary.BigEndian.Uint32(value), nil
	}

	numberBytes, err := readBytes(8)
	if err != nil {
		return record, err
	}
	record.RecordNumber = binary.BigEndian.Uint64(numberBytes)
	projectLength, err := readUint16(raw, &offset, checksumOffset)
	if err != nil {
		return record, err
	}
	if projectLength == 0 || projectLength > maxProjectIDBytes {
		return record, ErrInvalidBlockWALRecord
	}
	projectBytes, err := readBytes(int(projectLength))
	if err != nil {
		return record, err
	}
	if !utf8.Valid(projectBytes) || bytes.IndexByte(projectBytes, 0) >= 0 {
		return record, ErrInvalidBlockWALRecord
	}
	record.ProjectID = string(projectBytes)
	genesisBytes, err := readBytes(walDigestSize)
	if err != nil {
		return record, err
	}
	copy(record.GenesisDigest[:], genesisBytes)
	chainIDLength, err := readUint16(raw, &offset, checksumOffset)
	if err != nil {
		return record, err
	}
	if chainIDLength == 0 || chainIDLength > types.MaxChainIDLen {
		return record, ErrInvalidBlockWALRecord
	}
	chainIDBytes, err := readBytes(int(chainIDLength))
	if err != nil {
		return record, err
	}
	if !utf8.Valid(chainIDBytes) || bytes.IndexByte(chainIDBytes, 0) >= 0 {
		return record, ErrInvalidBlockWALRecord
	}
	record.ChainID = string(chainIDBytes)
	heightBytes, err := readBytes(8)
	if err != nil {
		return record, err
	}
	record.Height = binary.BigEndian.Uint64(heightBytes)
	blockHash, err := readBytes(walDigestSize)
	if err != nil {
		return record, err
	}
	record.BlockID.Hash = append([]byte(nil), blockHash...)
	partSetTotal, err := readUint32()
	if err != nil {
		return record, err
	}
	record.BlockID.PartSetHeader.Total = partSetTotal
	partSetHash, err := readBytes(walDigestSize)
	if err != nil {
		return record, err
	}
	record.BlockID.PartSetHeader.Hash = append([]byte(nil), partSetHash...)
	evidenceDigest, err := readBytes(walDigestSize)
	if err != nil {
		return record, err
	}
	copy(record.CommitEvidenceDigest[:], evidenceDigest)

	transactionCount, err := readUint32()
	if err != nil {
		return record, err
	}
	if transactionCount > MaxTransactionsPerBlock {
		return WALBlockRecord{}, ErrBlockWALRecordBounds
	}
	// Every transaction costs at least its four-byte length prefix, so a count
	// that cannot fit in the remaining bytes is rejected before allocation.
	if uint64(transactionCount) > uint64(checksumOffset-offset)/4 {
		return WALBlockRecord{}, ErrInvalidBlockWALRecord
	}
	record.Transactions = make([][]byte, transactionCount)
	aggregate := 0
	for i := uint32(0); i < transactionCount; i++ {
		length, err := readUint32()
		if err != nil {
			return WALBlockRecord{}, err
		}
		if length > MaxTransactionBytes {
			return WALBlockRecord{}, ErrBlockWALRecordBounds
		}
		// Bound the aggregate by subtraction so the check cannot overflow.
		if uint64(length) > uint64(MaxBlockDataBytes-aggregate) {
			return WALBlockRecord{}, ErrBlockWALRecordBounds
		}
		aggregate += int(length)
		tx, err := readBytes(int(length))
		if err != nil {
			return WALBlockRecord{}, err
		}
		record.Transactions[i] = append([]byte(nil), tx...)
	}

	dataHash, err := readBytes(walDigestSize)
	if err != nil {
		return WALBlockRecord{}, err
	}
	copy(record.BlockDataHash[:], dataHash)
	appHash, err := readBytes(walDigestSize)
	if err != nil {
		return WALBlockRecord{}, err
	}
	copy(record.PostBlockAppHash[:], appHash)
	previousDigest, err := readBytes(walDigestSize)
	if err != nil {
		return WALBlockRecord{}, err
	}
	copy(record.PreviousDigest[:], previousDigest)
	if offset != checksumOffset {
		return WALBlockRecord{}, ErrInvalidBlockWALRecord
	}
	if err := validateWALBlockRecordFields(record); err != nil {
		return WALBlockRecord{}, err
	}
	// The data hash is recomputed from the decoded transaction bytes with the
	// pinned library. A checksummed record whose stored hash disagrees with its
	// own payload is corrupt by construction and must not be replayed.
	computed, err := hashedTransactionData(record.Transactions)
	if err != nil {
		return WALBlockRecord{}, err
	}
	if !bytes.Equal(computed, record.BlockDataHash[:]) {
		return WALBlockRecord{}, ErrBlockWALDataHashMismatch
	}
	return record, nil
}

// WALBlockRecordDigest returns the SHA-256 digest of a fully validated encoded
// block frame, suitable as the next record's PreviousDigest.
func WALBlockRecordDigest(raw []byte) ([walDigestSize]byte, error) {
	if _, err := DecodeWALBlockRecord(raw); err != nil {
		return [walDigestSize]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

// VerifyWALBlockRecordLink checks local sequence, hash-chain, project, genesis
// and chain continuity between two encoded block records. It requires
// consecutive record numbers and strictly consecutive heights, because an ABCI
// application records every height it commits. It authenticates neither record.
func VerifyWALBlockRecordLink(previousRaw, currentRaw []byte) error {
	previous, err := DecodeWALBlockRecord(previousRaw)
	if err != nil {
		return fmt.Errorf("decode previous block WAL record: %w", err)
	}
	current, err := DecodeWALBlockRecord(currentRaw)
	if err != nil {
		return fmt.Errorf("decode current block WAL record: %w", err)
	}
	if previous.RecordNumber == ^uint64(0) ||
		current.RecordNumber != previous.RecordNumber+1 {
		return ErrBlockWALLink
	}
	digest := sha256.Sum256(previousRaw)
	if !bytes.Equal(current.PreviousDigest[:], digest[:]) {
		return ErrBlockWALLink
	}
	if current.ProjectID != previous.ProjectID ||
		current.GenesisDigest != previous.GenesisDigest ||
		current.ChainID != previous.ChainID {
		return ErrBlockWALLink
	}
	if current.Height <= previous.Height {
		return ErrBlockWALHeightRegression
	}
	if current.Height != previous.Height+1 {
		return ErrBlockWALHeightRegression
	}
	return nil
}

// SameWALBlockCommit reports whether two records describe the same committed
// block transition. Callers use it to distinguish an idempotent replay of an
// already recorded block from a conflicting block at the same height.
func SameWALBlockCommit(a, b WALBlockRecord) bool {
	if a.Height != b.Height ||
		a.ChainID != b.ChainID ||
		a.ProjectID != b.ProjectID ||
		a.GenesisDigest != b.GenesisDigest ||
		a.BlockDataHash != b.BlockDataHash ||
		a.PostBlockAppHash != b.PostBlockAppHash ||
		a.CommitEvidenceDigest != b.CommitEvidenceDigest {
		return false
	}
	return a.BlockID.Hash != nil && bytes.Equal(a.BlockID.Hash, b.BlockID.Hash) &&
		a.BlockID.PartSetHeader.Total == b.BlockID.PartSetHeader.Total &&
		bytes.Equal(a.BlockID.PartSetHeader.Hash, b.BlockID.PartSetHeader.Hash)
}

func validateWALBlockRecordFields(record WALBlockRecord) error {
	project := []byte(record.ProjectID)
	chainID := []byte(record.ChainID)
	if record.RecordNumber == 0 || record.Height == 0 ||
		len(project) == 0 || len(project) > maxProjectIDBytes ||
		!utf8.Valid(project) || bytes.IndexByte(project, 0) >= 0 ||
		len(chainID) == 0 || len(chainID) > types.MaxChainIDLen ||
		!utf8.Valid(chainID) || bytes.IndexByte(chainID, 0) >= 0 ||
		isZeroWALHash(record.GenesisDigest) ||
		isZeroWALHash(record.BlockDataHash) ||
		isZeroWALHash(record.PostBlockAppHash) ||
		isZeroWALHash(record.CommitEvidenceDigest) {
		return ErrInvalidBlockWALRecord
	}
	if record.RecordNumber == 1 && !isZeroWALHash(record.PreviousDigest) {
		return ErrInvalidBlockWALRecord
	}
	if record.RecordNumber > 1 && isZeroWALHash(record.PreviousDigest) {
		return ErrInvalidBlockWALRecord
	}
	if record.BlockID.PartSetHeader.Total == 0 ||
		len(record.BlockID.Hash) != tmhash.Size ||
		isZeroDigestBytes(record.BlockID.Hash) ||
		len(record.BlockID.PartSetHeader.Hash) != tmhash.Size ||
		isZeroDigestBytes(record.BlockID.PartSetHeader.Hash) {
		return ErrBlockWALBlockIDMismatch
	}
	if err := record.BlockID.ValidateBasic(); err != nil {
		return fmt.Errorf("%w: %v", ErrBlockWALBlockIDMismatch, err)
	}
	if !record.BlockID.IsComplete() {
		return ErrBlockWALBlockIDMismatch
	}
	if len(record.Transactions) > MaxTransactionsPerBlock {
		return ErrBlockWALRecordBounds
	}
	aggregate := 0
	for _, tx := range record.Transactions {
		if len(tx) > MaxTransactionBytes {
			return ErrBlockWALRecordBounds
		}
		if len(tx) > MaxBlockDataBytes-aggregate {
			return ErrBlockWALRecordBounds
		}
		aggregate += len(tx)
	}
	return nil
}

func isZeroDigestBytes(value []byte) bool {
	for _, b := range value {
		if b != 0 {
			return false
		}
	}
	return true
}

func appendUint16(out []byte, value uint16) []byte {
	return append(out, byte(value>>8), byte(value))
}

func appendUint32(out []byte, value uint32) []byte {
	return append(out, byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
}

func appendUint64(out []byte, value uint64) []byte {
	return append(out,
		byte(value>>56), byte(value>>48), byte(value>>40), byte(value>>32),
		byte(value>>24), byte(value>>16), byte(value>>8), byte(value))
}

func readUint16(raw []byte, offset *int, limit int) (uint16, error) {
	if limit-*offset < 2 {
		return 0, ErrInvalidBlockWALRecord
	}
	value := binary.BigEndian.Uint16(raw[*offset:])
	*offset += 2
	return value, nil
}
