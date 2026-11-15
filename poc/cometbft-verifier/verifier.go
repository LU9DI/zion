// Package verifier contains the first isolated, test-only CometBFT commit
// certificate verifier. It is not wired into Zion runtime or admission logic.
package verifier

import (
	"bytes"
	"errors"
	"fmt"

	"github.com/cometbft/cometbft/types"
)

var (
	ErrMissingEvidence       = errors.New("missing commit evidence")
	ErrInvalidChainID        = errors.New("invalid chain ID")
	ErrInvalidHeight         = errors.New("invalid commit height")
	ErrValidatorSetMismatch  = errors.New("validator set digest mismatch")
	ErrCommitMismatch        = errors.New("commit does not match expected block")
	ErrSignatureVectorLength = errors.New("commit signature vector length does not match validator set")
)

// Evidence carries the expected project-chain context alongside a CometBFT
// commit. ValidatorSetHash must come from an independently authenticated
// validator-set record; this function does not authenticate that trust anchor.
type Evidence struct {
	ChainID         string
	Height          int64
	BlockID         types.BlockID
	ValidatorSetHash []byte
	Commit          *types.Commit
}

// VerifyCommitEvidence validates the evidence envelope and delegates all
// voting-power and cryptographic signature checks to CometBFT v0.38.26.
//
// This proves a commit relative to the supplied validator set only. It does
// not verify a signed header, application-state execution, validator-set
// transitions, or the authenticity of the supplied validator set.
func VerifyCommitEvidence(e Evidence, validators *types.ValidatorSet) error {
	if validators == nil || e.Commit == nil {
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
