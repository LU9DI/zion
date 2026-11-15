package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	walRecordVersion       = uint16(1)
	walRecordMagic         = "ZWL1"
	walDigestSize          = sha256.Size
	walFixedRecordBytes    = 4 + 2 + 4 + 8 + 2 + 32 + 8 + 32 + 4 + 32 + 4 + 4 + 32 + 32 + 32
	MaxWALRecordBytes      = 2 << 20
)

var (
	ErrInvalidWALRecord = errors.New("invalid canonical WAL record")
	ErrWALRecordBounds  = errors.New("WAL record exceeds configured bounds")
	ErrWALChecksum      = errors.New("WAL record checksum mismatch")
	ErrWALLink          = errors.New("WAL record chain link mismatch")
)

// WALRecord is one canonical, checksummed application-log entry. The codec
// does not establish consensus finality or authenticate the record's writer.
type WALRecord struct {
	RecordNumber   uint64
	ProjectID      string
	GenesisDigest  [walDigestSize]byte
	Height         uint64
	BlockIDHash    [walDigestSize]byte
	BlockIDPartSetTotal uint32
	BlockIDPartSetHash [walDigestSize]byte
	TransactionIndex uint32
	Transaction    []byte
	PreviousDigest [walDigestSize]byte
	AppHash        [walDigestSize]byte
}

// EncodeWALRecord emits the canonical ZWL1 v1 format. All integers are
// big-endian. The total-length field includes the trailing SHA-256 checksum.
func EncodeWALRecord(record WALRecord) ([]byte, error) {
	if err := validateWALRecordFields(record); err != nil {
		return nil, err
	}

	project := []byte(record.ProjectID)
	total := uint64(walFixedRecordBytes) + uint64(len(project)) + uint64(len(record.Transaction))
	if total > MaxWALRecordBytes || total > uint64(^uint32(0)) {
		return nil, ErrWALRecordBounds
	}

	out := make([]byte, int(total))
	offset := 0
	copy(out[offset:], walRecordMagic)
	offset += len(walRecordMagic)
	binary.BigEndian.PutUint16(out[offset:], walRecordVersion)
	offset += 2
	binary.BigEndian.PutUint32(out[offset:], uint32(total))
	offset += 4
	binary.BigEndian.PutUint64(out[offset:], record.RecordNumber)
	offset += 8
	binary.BigEndian.PutUint16(out[offset:], uint16(len(project)))
	offset += 2
	copy(out[offset:], project)
	offset += len(project)
	copy(out[offset:], record.GenesisDigest[:])
	offset += walDigestSize
	binary.BigEndian.PutUint64(out[offset:], record.Height)
	offset += 8
	copy(out[offset:], record.BlockIDHash[:])
	offset += walDigestSize
	binary.BigEndian.PutUint32(out[offset:], record.BlockIDPartSetTotal)
	offset += 4
	copy(out[offset:], record.BlockIDPartSetHash[:])
	offset += walDigestSize
	binary.BigEndian.PutUint32(out[offset:], record.TransactionIndex)
	offset += 4
	binary.BigEndian.PutUint32(out[offset:], uint32(len(record.Transaction)))
	offset += 4
	copy(out[offset:], record.Transaction)
	offset += len(record.Transaction)
	copy(out[offset:], record.PreviousDigest[:])
	offset += walDigestSize
	copy(out[offset:], record.AppHash[:])
	offset += walDigestSize

	checksum := sha256.Sum256(out[:offset])
	copy(out[offset:], checksum[:])
	return out, nil
}

// DecodeWALRecord strictly decodes one complete canonical ZWL1 v1 record.
// It rejects truncation, trailing bytes, unknown versions, oversized fields,
// invalid project identifiers, and checksum mismatches.
func DecodeWALRecord(raw []byte) (WALRecord, error) {
	var record WALRecord
	if len(raw) < walFixedRecordBytes+1 {
		return record, ErrInvalidWALRecord
	}
	if len(raw) > MaxWALRecordBytes {
		return record, ErrWALRecordBounds
	}
	if string(raw[:4]) != walRecordMagic {
		return record, ErrInvalidWALRecord
	}
	if binary.BigEndian.Uint16(raw[4:6]) != walRecordVersion {
		return record, ErrInvalidWALRecord
	}
	declaredLength := binary.BigEndian.Uint32(raw[6:10])
	if uint64(declaredLength) != uint64(len(raw)) {
		return record, ErrInvalidWALRecord
	}

	checksumOffset := len(raw) - walDigestSize
	expectedChecksum := sha256.Sum256(raw[:checksumOffset])
	if !bytes.Equal(expectedChecksum[:], raw[checksumOffset:]) {
		return record, ErrWALChecksum
	}

	offset := 10
	record.RecordNumber = binary.BigEndian.Uint64(raw[offset:])
	offset += 8
	projectLength := int(binary.BigEndian.Uint16(raw[offset:]))
	offset += 2
	if projectLength == 0 || projectLength > maxProjectIDBytes || projectLength > checksumOffset-offset {
		return WALRecord{}, ErrInvalidWALRecord
	}
	projectBytes := raw[offset : offset+projectLength]
	if !utf8.Valid(projectBytes) {
		return WALRecord{}, ErrInvalidWALRecord
	}
	record.ProjectID = string(projectBytes)
	offset += projectLength

	if checksumOffset-offset < walDigestSize+8+walDigestSize+4+walDigestSize+4+4+walDigestSize+walDigestSize {
		return WALRecord{}, ErrInvalidWALRecord
	}
	copy(record.GenesisDigest[:], raw[offset:offset+walDigestSize])
	offset += walDigestSize
	record.Height = binary.BigEndian.Uint64(raw[offset:])
	offset += 8
	copy(record.BlockIDHash[:], raw[offset:offset+walDigestSize])
	offset += walDigestSize
	record.BlockIDPartSetTotal = binary.BigEndian.Uint32(raw[offset:])
	offset += 4
	copy(record.BlockIDPartSetHash[:], raw[offset:offset+walDigestSize])
	offset += walDigestSize
	record.TransactionIndex = binary.BigEndian.Uint32(raw[offset:])
	offset += 4
	transactionLength := uint64(binary.BigEndian.Uint32(raw[offset:]))
	offset += 4
	if transactionLength > MaxTransactionBytes || transactionLength > uint64(checksumOffset-offset) {
		return WALRecord{}, ErrWALRecordBounds
	}
	if uint64(checksumOffset-offset) != transactionLength+2*walDigestSize {
		return WALRecord{}, ErrInvalidWALRecord
	}
	record.Transaction = append([]byte(nil), raw[offset:offset+int(transactionLength)]...)
	offset += int(transactionLength)
	copy(record.PreviousDigest[:], raw[offset:offset+walDigestSize])
	offset += walDigestSize
	copy(record.AppHash[:], raw[offset:offset+walDigestSize])
	offset += walDigestSize
	if offset != checksumOffset {
		return WALRecord{}, ErrInvalidWALRecord
	}
	if err := validateWALRecordFields(record); err != nil {
		return WALRecord{}, err
	}
	return record, nil
}

func validateWALRecordFields(record WALRecord) error {
	project := []byte(record.ProjectID)
	if record.RecordNumber == 0 || record.Height == 0 ||
		len(project) == 0 || len(project) > maxProjectIDBytes ||
		!utf8.Valid(project) || bytes.IndexByte(project, 0) >= 0 ||
		isZeroWALHash(record.GenesisDigest) || isZeroWALHash(record.BlockIDHash) ||
		record.BlockIDPartSetTotal == 0 || isZeroWALHash(record.BlockIDPartSetHash) ||
		isZeroWALHash(record.AppHash) {
		return ErrInvalidWALRecord
	}
	if record.RecordNumber == 1 && !isZeroWALHash(record.PreviousDigest) {
		return ErrInvalidWALRecord
	}
	if record.RecordNumber > 1 && isZeroWALHash(record.PreviousDigest) {
		return ErrInvalidWALRecord
	}
	if record.TransactionIndex >= MaxTransactionsPerBlock ||
		len(record.Transaction) > MaxTransactionBytes {
		return ErrWALRecordBounds
	}
	return nil
}

func isZeroWALHash(value [walDigestSize]byte) bool {
	for _, b := range value {
		if b != 0 {
			return false
		}
	}
	return true
}

// WALRecordDigest returns the SHA-256 digest of a fully validated encoded
// record. The digest is suitable as the next record's PreviousDigest; it is
// not a signature, MAC, or proof of consensus commitment.
func WALRecordDigest(raw []byte) ([walDigestSize]byte, error) {
	if _, err := DecodeWALRecord(raw); err != nil {
		return [walDigestSize]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

// VerifyWALRecordLink checks local sequence and hash-chain continuity between
// two encoded records. It does not authenticate either record.
func VerifyWALRecordLink(previousRaw, currentRaw []byte) error {
	previous, err := DecodeWALRecord(previousRaw)
	if err != nil {
		return fmt.Errorf("decode previous WAL record: %w", err)
	}
	current, err := DecodeWALRecord(currentRaw)
	if err != nil {
		return fmt.Errorf("decode current WAL record: %w", err)
	}
	if previous.RecordNumber == ^uint64(0) ||
		current.RecordNumber != previous.RecordNumber+1 {
		return ErrWALLink
	}
	digest := sha256.Sum256(previousRaw)
	if !bytes.Equal(current.PreviousDigest[:], digest[:]) {
		return ErrWALLink
	}
	if current.ProjectID != previous.ProjectID ||
		current.GenesisDigest != previous.GenesisDigest ||
		current.Height < previous.Height {
		return ErrWALLink
	}
	return nil
}
