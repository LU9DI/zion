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
	ErrAppHashMismatch       = errors.New("header app hash does not match independently expected state hash")
	ErrDataHashMismatch      = errors.New("header data hash does not match supplied ordered transactions")
	ErrDataBounds            = errors.New("block transaction data exceeds verifier bounds")
	ErrSignatureVectorLength = errors.New("commit signature vector length does not match validator set")
)

// Evidence carries the expected project-chain context alongside a CometBFT
// signed header, ordered raw transaction bytes, and commit. ValidatorSetHash
// must come from an independently authenticated validator-set record.
// ExpectedAppHash must come from independently replayed application history
// or a separately verified state snapshot.
type Evidence struct {
	ChainID          string
	Height           int64
	BlockID          types.BlockID
	ValidatorSetHash []byte
	ExpectedAppHash  []byte
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
	if len(e.ExpectedAppHash) == 0 || !bytes.Equal(e.Header.AppHash, e.ExpectedAppHash) {
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
	// CometBFT represents an empty transaction list with a nil data hash.
	// Equality must therefore accept nil/nil for valid empty blocks.
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
	ExpectedAppHash       []byte
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
		ExpectedAppHash:  e.ExpectedAppHash,
		Transactions:     e.Transactions,
		Header:           &header,
		Commit:           commit,
	}, validators)
}
