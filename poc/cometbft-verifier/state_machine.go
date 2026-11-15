package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
)

const (
	stateSchemaVersion = uint16(1)
	maxProjectIDBytes  = 128
	maxOperationIDBytes = 16
	maxStateKeyBytes   = 256
	maxStateValueBytes = 4096
	maxStateTxBytes    = 8192
)

var (
	ErrInvalidTransaction = errors.New("invalid canonical state transaction")
	ErrWrongProject       = errors.New("transaction belongs to another project")
	ErrSequenceConflict   = errors.New("transaction expected sequence does not match state")
	ErrOperationConflict  = errors.New("operation ID was reused with different transaction bytes")
	ErrMissingStateKey    = errors.New("delete target does not exist")
	ErrSequenceExhausted  = errors.New("application sequence is exhausted")
	ErrInvalidGenesis     = errors.New("invalid state genesis")
)

const (
	statePut byte = 1
	stateDelete byte = 2
)

// StateTransaction is a decoded canonical v1 command. OperationID is exactly
// 16 bytes. EncodeStateTransaction is the only supported wire encoder.
type StateTransaction struct {
	ProjectID string
	OperationID []byte
	Kind byte
	ExpectedSequence uint64
	Key []byte
	Value []byte
}

// StateMachine is a deterministic, in-memory replay model for the disposable
// CometBFT PoC. It is not durable storage, an ABCI application, or production
// Zion state.
type StateMachine struct {
	projectID string
	genesisDigest [32]byte
	sequence uint64
	kv map[string][]byte
	operations map[string]stateOperation
}

type stateOperation struct {
	digest [32]byte
	result byte
}

// NewStateMachine binds an empty state to an immutable project and genesis digest.
func NewStateMachine(projectID string, genesisDigest []byte) (*StateMachine, error) {
	if projectID == "" || len(projectID) > maxProjectIDBytes || len(genesisDigest) != sha256.Size {
		return nil, ErrInvalidGenesis
	}
	s := &StateMachine{
		projectID: projectID,
		kv: make(map[string][]byte),
		operations: make(map[string]stateOperation),
	}
	copy(s.genesisDigest[:], genesisDigest)
	return s, nil
}

// EncodeStateTransaction emits a strict binary envelope:
// "ZTX1" | projectLen:u16 | project | operationID:16 | kind:u8 |
// expectedSequence:u64 | keyLen:u16 | key | valueLen:u32 | value.
func EncodeStateTransaction(tx StateTransaction) ([]byte, error) {
	if tx.ProjectID == "" || len(tx.ProjectID) > maxProjectIDBytes ||
		len(tx.OperationID) != maxOperationIDBytes ||
		len(tx.Key) == 0 || len(tx.Key) > maxStateKeyBytes ||
		len(tx.Value) > maxStateValueBytes {
		return nil, ErrInvalidTransaction
	}
	if tx.Kind != statePut && tx.Kind != stateDelete {
		return nil, ErrInvalidTransaction
	}
	if tx.Kind == stateDelete && len(tx.Value) != 0 {
		return nil, ErrInvalidTransaction
	}
	var b bytes.Buffer
	b.WriteString("ZTX1")
	_ = binary.Write(&b, binary.BigEndian, uint16(len(tx.ProjectID)))
	b.WriteString(tx.ProjectID)
	b.Write(tx.OperationID)
	b.WriteByte(tx.Kind)
	_ = binary.Write(&b, binary.BigEndian, tx.ExpectedSequence)
	_ = binary.Write(&b, binary.BigEndian, uint16(len(tx.Key)))
	b.Write(tx.Key)
	_ = binary.Write(&b, binary.BigEndian, uint32(len(tx.Value)))
	b.Write(tx.Value)
	if b.Len() > maxStateTxBytes {
		return nil, ErrInvalidTransaction
	}
	return b.Bytes(), nil
}

func decodeStateTransaction(raw []byte) (StateTransaction, error) {
	var tx StateTransaction
	if len(raw) < 4+2+1+maxOperationIDBytes+1+8+2+1+4 || len(raw) > maxStateTxBytes || string(raw[:4]) != "ZTX1" {
		return tx, ErrInvalidTransaction
	}
	r := bytes.NewReader(raw[4:])
	var projectLen uint16
	if binary.Read(r, binary.BigEndian, &projectLen) != nil || projectLen == 0 || projectLen > maxProjectIDBytes || int(projectLen) > r.Len() {
		return tx, ErrInvalidTransaction
	}
	project := make([]byte, projectLen)
	if _, err := r.Read(project); err != nil { return tx, ErrInvalidTransaction }
	tx.ProjectID = string(project)
	tx.OperationID = make([]byte, maxOperationIDBytes)
	if _, err := r.Read(tx.OperationID); err != nil { return tx, ErrInvalidTransaction }
	kind, err := r.ReadByte()
	if err != nil || (kind != statePut && kind != stateDelete) { return tx, ErrInvalidTransaction }
	tx.Kind = kind
	if binary.Read(r, binary.BigEndian, &tx.ExpectedSequence) != nil { return tx, ErrInvalidTransaction }
	var keyLen uint16
	if binary.Read(r, binary.BigEndian, &keyLen) != nil || keyLen == 0 || keyLen > maxStateKeyBytes || int(keyLen) > r.Len() { return tx, ErrInvalidTransaction }
	tx.Key = make([]byte, keyLen)
	if _, err := r.Read(tx.Key); err != nil { return tx, ErrInvalidTransaction }
	var valueLen uint32
	if binary.Read(r, binary.BigEndian, &valueLen) != nil || valueLen > maxStateValueBytes || uint64(valueLen) > uint64(r.Len()) { return tx, ErrInvalidTransaction }
	tx.Value = make([]byte, valueLen)
	if _, err := r.Read(tx.Value); err != nil { return tx, ErrInvalidTransaction }
	if r.Len() != 0 || (tx.Kind == stateDelete && len(tx.Value) != 0) { return tx, ErrInvalidTransaction }
	return tx, nil
}

// Apply executes one already-ordered transaction. Identical operation retries
// return their original result without mutation; a changed payload under the
// same ID is rejected. Rejections do not advance sequence or enter the index.
func (s *StateMachine) Apply(raw []byte) (byte, error) {
	if s == nil { return 0, ErrInvalidGenesis }
	tx, err := decodeStateTransaction(raw)
	if err != nil { return 0, err }
	if tx.ProjectID != s.projectID { return 0, ErrWrongProject }
	digest := sha256.Sum256(raw)
	opID := string(tx.OperationID)
	if prior, ok := s.operations[opID]; ok {
		if prior.digest != digest { return 0, ErrOperationConflict }
		return prior.result, nil
	}
	if tx.ExpectedSequence != s.sequence { return 0, ErrSequenceConflict }
	if s.sequence == ^uint64(0) { return 0, ErrSequenceExhausted }
	key := string(tx.Key)
	switch tx.Kind {
	case statePut:
		s.kv[key] = append([]byte(nil), tx.Value...)
	case stateDelete:
		if _, ok := s.kv[key]; !ok { return 0, ErrMissingStateKey }
		delete(s.kv, key)
	}
	s.sequence++
	s.operations[opID] = stateOperation{digest: digest, result: 1}
	return 1, nil
}

// Replay applies a block's ordered transactions and stops on the first invalid
// command. Callers must replay into a disposable copy if block-level atomicity
// is required; this helper intentionally does not imply durable commit.
func (s *StateMachine) Replay(transactions [][]byte) error {
	for i, raw := range transactions {
		if _, err := s.Apply(raw); err != nil {
			return fmt.Errorf("transaction %d: %w", i, err)
		}
	}
	return nil
}

func (s *StateMachine) Sequence() uint64 {
	if s == nil { return 0 }
	return s.sequence
}

// AppHash returns a domain-separated SHA-256 over canonical state bytes.
// Maps are sorted by raw key bytes; all lengths and integers are big-endian.
func (s *StateMachine) AppHash() []byte {
	if s == nil { return nil }
	var b bytes.Buffer
	b.WriteString("ZION-POC-APPSTATE")
	_ = binary.Write(&b, binary.BigEndian, stateSchemaVersion)
	_ = binary.Write(&b, binary.BigEndian, uint16(len(s.projectID)))
	b.WriteString(s.projectID)
	b.Write(s.genesisDigest[:])
	_ = binary.Write(&b, binary.BigEndian, s.sequence)
	keys := make([]string, 0, len(s.kv))
	for key := range s.kv { keys = append(keys, key) }
	sort.Slice(keys, func(i,j int) bool { return bytes.Compare([]byte(keys[i]), []byte(keys[j])) < 0 })
	_ = binary.Write(&b, binary.BigEndian, uint32(len(keys)))
	for _, key := range keys {
		value := s.kv[key]
		_ = binary.Write(&b, binary.BigEndian, uint16(len(key)))
		b.WriteString(key)
		_ = binary.Write(&b, binary.BigEndian, uint32(len(value)))
		b.Write(value)
	}
	opIDs := make([]string, 0, len(s.operations))
	for id := range s.operations { opIDs = append(opIDs, id) }
	sort.Slice(opIDs, func(i,j int) bool { return bytes.Compare([]byte(opIDs[i]), []byte(opIDs[j])) < 0 })
	_ = binary.Write(&b, binary.BigEndian, uint32(len(opIDs)))
	for _, id := range opIDs {
		op := s.operations[id]
		b.WriteString(id)
		b.Write(op.digest[:])
		b.WriteByte(op.result)
	}
	sum := sha256.Sum256(b.Bytes())
	return sum[:]
}
