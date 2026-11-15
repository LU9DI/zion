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

var (
	ErrMissingEvidence       = errors.New("missing commit evidence")
	ErrInvalidChainID        = errors.New("invalid chain ID")
	ErrInvalidHeight         = errors.New("invalid commit height")
	ErrValidatorSetMismatch  = errors.New("validator set digest mismatch")
	ErrCommitMismatch        = errors.New("commit does not match expected block")
	ErrHeaderMismatch        = errors.New("signed header does not match expected block context")
	ErrAppHashMismatch       = errors.New("header app hash does not match independently expected state hash")
	ErrSignatureVectorLength = errors.New("commit signature vector length does not match validator set")
)

// Evidence carries the expected project-chain context alongside a CometBFT
// signed header and commit. ValidatorSetHash must come from an independently
// authenticated validator-set record. ExpectedAppHash must come from
// independently replayed application history or a separately verified state
// snapshot; it must never be copied from the untrusted header being checked.
type Evidence struct {
	ChainID          string
	Height           int64
	BlockID          types.BlockID
	ValidatorSetHash []byte
	ExpectedAppHash  []byte
	Header           *types.Header
	Commit           *types.Commit
}

// VerifyCommitEvidence binds the signed header to the committed block ID,
// chain/height, authenticated validator-set digest, and independently
// expected application state hash, then delegates full certificate checks
// to CometBFT v0.38.26.
//
// This still does not authenticate the validator set or recompute the app
// hash. Those trust/replay operations belong to the caller.
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

// ProtoEvidence is the wire-format form exported by a CometBFT block store.
// The validator set and expected app hash must still be authenticated or
// independently recomputed by the caller's trust/replay process.
type ProtoEvidence struct {
	ChainID              string
	Height               int64
	BlockID              *cmtproto.BlockID
	Header               *cmtproto.Header
	ValidatorSet         *cmtproto.ValidatorSet
	ExpectedValidatorHash []byte
	ExpectedAppHash      []byte
	Commit               *cmtproto.Commit
}

// VerifyProtoCommitEvidence converts untrusted protobuf objects using
// CometBFT's pinned v0.38.26 conversion routines, then verifies header binding
// and the full commit certificate.
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
		Header:           &header,
		Commit:           commit,
	}, validators)
}
