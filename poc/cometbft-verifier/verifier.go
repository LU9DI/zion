// Package verifier contains the first isolated, test-only CometBFT commit
// certificate verifier. It is not wired into Zion runtime or admission logic.
package verifier

import (
	"bytes"
	"errors"
	"fmt"

	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/cometbft/cometbft/types"
)

const (
	// These limits bound work on untrusted evidence in this PoC verifier.
	MaxTransactionsPerBlock = 10_000
	MaxTransactionBytes     = 1 << 20
	MaxBlockDataBytes       = 16 << 20
)

var (
	ErrMissingEvidence       = errors.New("missing commit evidence")
	ErrInvalidChainID        = errors.New("invalid chain ID")
	ErrInvalidHeight         = errors.New("invalid commit height")
	ErrValidatorSetMismatch  = errors.New("validator set digest mismatch")
	ErrCommitMismatch        = errors.New("commit does not match expected block")
	ErrHeaderMismatch        = errors.New("signed header does not match expected block context")
	ErrAppHashMismatch       = errors.New("post-block application hash mismatch")
	ErrPreBlockAppHashMismatch = errors.New("pre-block application hash does not match the signed header")
	ErrDataHashMismatch      = errors.New("header data hash does not match supplied ordered transactions")
	ErrDataBounds            = errors.New("block transaction data exceeds verifier bounds")
	ErrSignatureVectorLength = errors.New("commit signature vector length does not match validator set")
)

// Evidence carries the expected project-chain context alongside a CometBFT
// signed header, ordered raw transaction bytes, and commit. ValidatorSetHash
// must come from an independently authenticated validator-set record.
// ExpectedPreBlockAppHash must match Header.AppHash at the start of this block.
// ExpectedPostBlockAppHash must be independently authenticated (for example by
// the next verified header) and is distinct from Header.AppHash.
type Evidence struct {
	ChainID          string
	Height           int64
	BlockID          types.BlockID
	ValidatorSetHash []byte
	ExpectedPreBlockAppHash  []byte
	ExpectedPostBlockAppHash []byte
	Transactions     [][]byte
	Header           *types.Header
	Commit           *types.Commit
}

// VerifyCommitEvidence binds the signed header to the committed block ID,
// chain/height, authenticated validator-set digest, independently expected
// application state hash, and ordered transaction bytes. It then delegates
// full certificate checks to CometBFT v0.38.26.
//
// This does not authenticate the validator set, recompute the app hash, or
// execute application transactions. Those trust/replay operations belong
// to the caller.
func VerifyCommitEvidence(e Evidence, validators *types.ValidatorSet) error {
	if validators == nil || e.Commit == nil || e.Header == nil {
		return ErrMissingEvidence
	}
	if e.ChainID == "" {
		return ErrInvalidChainID
	}
	if e.Height <= 0 {
		return ErrInvalidHeight
	}
	if err := validators.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid validator set: %w", err)
	}
	if err := e.BlockID.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid expected block ID: %w", err)
	}
	if !e.BlockID.IsComplete() {
		return fmt.Errorf("expected block ID is incomplete")
	}
	if len(e.ValidatorSetHash) == 0 || !bytes.Equal(validators.Hash(), e.ValidatorSetHash) {
		return ErrValidatorSetMismatch
	}
	if len(e.ExpectedPreBlockAppHash) == 0 || !bytes.Equal(e.Header.AppHash, e.ExpectedPreBlockAppHash) {
		return ErrPreBlockAppHashMismatch
	}
	if len(e.ExpectedPostBlockAppHash) == 0 {
		return ErrAppHashMismatch
	}
	if err := verifyTransactionData(e.Transactions, e.Header.DataHash); err != nil {
		return err
	}
	if err := e.Header.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid signed header: %w", err)
	}
	if e.Header.ChainID != e.ChainID ||
		e.Header.Height != e.Height ||
		!bytes.Equal(e.Header.Hash(), e.BlockID.Hash) ||
		!bytes.Equal(e.Header.ValidatorsHash, e.ValidatorSetHash) {
		return ErrHeaderMismatch
	}
	if err := e.Commit.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid commit structure: %w", err)
	}
	if e.Commit.Height != e.Height || !e.Commit.BlockID.Equals(e.BlockID) {
		return ErrCommitMismatch
	}
	if len(e.Commit.Signatures) != validators.Size() {
		return ErrSignatureVectorLength
	}

	// VerifyCommit checks the >2/3 voting-power threshold and all signatures.
	// Do not replace this with VerifyCommitLight: that method intentionally
	// skips full signature validation.
	if err := validators.VerifyCommit(e.ChainID, e.BlockID, e.Height, e.Commit); err != nil {
		return fmt.Errorf("CometBFT commit verification failed: %w", err)
	}
	return nil
}

// VerifyCommitEvidenceWithReplay independently executes the ordered transaction
// bytes against a trusted initial state, compares the resulting app hash with
// the expected/header app hash, and only then verifies the CometBFT commit.
// The supplied initial state is never mutated.
func VerifyCommitEvidenceWithReplay(e Evidence, validators *types.ValidatorSet, initial *StateMachine) (*StateMachine, error) {
	if initial == nil {
		return nil, ErrMissingEvidence
	}
	if len(e.ExpectedPreBlockAppHash) == 0 || !bytes.Equal(initial.AppHash(), e.ExpectedPreBlockAppHash) || !bytes.Equal(initial.AppHash(), e.Header.AppHash) {
		return nil, ErrPreBlockAppHashMismatch
	}
	replayed := initial.Clone()
	if err := replayed.Replay(e.Transactions); err != nil {
		return nil, fmt.Errorf("deterministic application replay failed: %w", err)
	}
	if len(e.ExpectedPostBlockAppHash) == 0 || !bytes.Equal(replayed.AppHash(), e.ExpectedPostBlockAppHash) {
		return nil, ErrAppHashMismatch
	}
	if err := VerifyCommitEvidence(e, validators); err != nil {
		return nil, err
	}
	return replayed, nil
}

func verifyTransactionData(raw [][]byte, expectedDataHash []byte) error {
	if len(raw) > MaxTransactionsPerBlock {
		return ErrDataBounds
	}
	total := 0
	var txs types.Txs
	if len(raw) > 0 {
		txs = make(types.Txs, len(raw))
	}
	for i, tx := range raw {
		if len(tx) > MaxTransactionBytes {
			return ErrDataBounds
		}
		total += len(tx)
		if total > MaxBlockDataBytes {
			return ErrDataBounds
		}
		txs[i] = append(types.Tx(nil), tx...)
	}
	// CometBFT represents an empty transaction list with the RFC-6962
	// Merkle empty-root hash. Do not special-case nil: it is not that root.
	if !bytes.Equal(txs.Hash(), expectedDataHash) {
		return ErrDataHashMismatch
	}
	return nil
}

// ProtoEvidence is the wire-format form exported by a CometBFT block store.
// The validator set and expected app hash must still be authenticated or
// independently recomputed by the caller's trust/replay process.
type ProtoEvidence struct {
	ChainID               string
	Height                int64
	BlockID               *cmtproto.BlockID
	Header                *cmtproto.Header
	ValidatorSet          *cmtproto.ValidatorSet
	ExpectedValidatorHash []byte
	ExpectedPreBlockAppHash  []byte
	ExpectedPostBlockAppHash []byte
	Transactions          [][]byte
	Commit                *cmtproto.Commit
}

// VerifyProtoCommitEvidence converts untrusted protobuf objects using
// CometBFT's pinned v0.38.26 conversion routines, then verifies header binding,
// ordered transaction data, and the full commit certificate.
func VerifyProtoCommitEvidence(e ProtoEvidence) error {
	if e.BlockID == nil || e.Header == nil || e.ValidatorSet == nil || e.Commit == nil {
		return ErrMissingEvidence
	}
	validators, err := types.ValidatorSetFromProto(e.ValidatorSet)
	if err != nil {
		return fmt.Errorf("decode validator set: %w", err)
	}
	blockID, err := types.BlockIDFromProto(e.BlockID)
	if err != nil {
		return fmt.Errorf("decode block ID: %w", err)
	}
	header, err := types.HeaderFromProto(e.Header)
	if err != nil {
		return fmt.Errorf("decode signed header: %w", err)
	}
	commit, err := types.CommitFromProto(e.Commit)
	if err != nil {
		return fmt.Errorf("decode commit: %w", err)
	}
	return VerifyCommitEvidence(Evidence{
		ChainID:          e.ChainID,
		Height:           e.Height,
		BlockID:          *blockID,
		ValidatorSetHash: e.ExpectedValidatorHash,
		ExpectedPreBlockAppHash:  e.ExpectedPreBlockAppHash,
		ExpectedPostBlockAppHash: e.ExpectedPostBlockAppHash,
		Transactions:     e.Transactions,
		Header:           &header,
		Commit:           commit,
	}, validators)
}
