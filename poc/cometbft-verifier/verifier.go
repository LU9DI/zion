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
	// MaxCommitSignatures bounds the untrusted commit signature vector before
	// any per-entry validation or protobuf conversion allocates work for it.
	// A commit signature vector must be exactly the validator-set size, so this
	// is also an upper bound on an acceptable validator set. The value is the
	// pinned CometBFT release's own vote-count limit, not a new parameter: a
	// larger commit cannot pass that release's ValidateBasic in any case.
	MaxCommitSignatures = types.MaxVotesCount
	// MaxValidatorSetSize bounds a caller-supplied validator set for the same
	// reason: every per-validator check below is linear in this value.
	MaxValidatorSetSize = types.MaxVotesCount
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
	ErrMissingPostBlockAnchor = errors.New("missing authenticated next-header anchor")
	ErrPostBlockAnchorMismatch = errors.New("next-header anchor does not authenticate the post-block state")
	ErrDataHashMismatch      = errors.New("header data hash does not match supplied ordered transactions")
	ErrDataBounds            = errors.New("block transaction data exceeds verifier bounds")
	ErrSignatureVectorLength = errors.New("commit signature vector length does not match validator set")
	ErrValidatorSetBounds    = errors.New("validator set exceeds verifier bounds")
)

// Evidence carries the expected project-chain context alongside a CometBFT
// signed header, ordered raw transaction bytes, and commit. ValidatorSetHash
// must come from an independently authenticated validator-set record.
// ExpectedPreBlockAppHash must match Header.AppHash at the start of this block.
// ExpectedPostBlockAppHash must match the next verified header AppHash; replay
// rejects it unless a PostBlockAnchor authenticates that next header and commit.
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
	PostBlockAnchor  *PostBlockAnchor
}


// PostBlockAnchor authenticates the application hash after Evidence.Height by
// verifying the next committed header and its validator-set transition.
type PostBlockAnchor struct {
	Header *types.Header
	BlockID types.BlockID
	Commit *types.Commit
	Validators *types.ValidatorSet
}

// VerifyCommitEvidence binds the signed header to the committed block ID,
// chain/height, authenticated current validator-set digest, pre-block state hash,
// and ordered transaction bytes. It verifies the current-height commit certificate
// with CometBFT v0.38.26. It does not authenticate the validator-set history,
// recompute application state, or authenticate the post-block hash; callers needing
// a post-state result must use VerifyCommitEvidenceWithReplay and a PostBlockAnchor.
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
	// Bound the untrusted signature vector and the caller-supplied validator set
	// before validating, hashing, or verifying anything that is linear in their
	// size. Without this ordering an oversized commit is walked entry by entry
	// (Commit.ValidateBasic and VerifyCommit) before the length agreement is
	// ever established.
	if validators.Size() > MaxValidatorSetSize || len(e.Commit.Signatures) > MaxCommitSignatures {
		return ErrSignatureVectorLength
	}
	if len(e.Commit.Signatures) != validators.Size() {
		return ErrSignatureVectorLength
	}
	if len(e.ValidatorSetHash) == 0 || !bytes.Equal(validators.Hash(), e.ValidatorSetHash) {
		return ErrValidatorSetMismatch
	}
	if len(e.ExpectedPreBlockAppHash) == 0 || !bytes.Equal(e.Header.AppHash, e.ExpectedPreBlockAppHash) {
		return ErrPreBlockAppHashMismatch
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

	// VerifyCommit checks the >2/3 voting-power threshold and all signatures.
	// Do not replace this with VerifyCommitLight: that method intentionally
	// skips full signature validation.
	if err := validators.VerifyCommit(e.ChainID, e.BlockID, e.Height, e.Commit); err != nil {
		return fmt.Errorf("CometBFT commit verification failed: %w", err)
	}
	// The header and full commit certificate are authenticated before hashing
	// or copying the bounded transaction payload supplied by an untrusted peer.
	if err := verifyTransactionData(e.Transactions, e.Header.DataHash); err != nil {
		return err
	}
	return nil
}

// VerifyCommitEvidenceWithReplay binds the pre-block state, replays the exact
// ordered transactions, and requires a separately committed next-header anchor
// to authenticate the post-block application hash. The supplied state is never mutated.
func VerifyCommitEvidenceWithReplay(e Evidence, validators *types.ValidatorSet, initial *StateMachine, anchor *PostBlockAnchor) (*StateMachine, error) {
	if initial == nil || e.Header == nil {
		return nil, ErrMissingEvidence
	}
	if len(e.ExpectedPreBlockAppHash) == 0 || !bytes.Equal(initial.AppHash(), e.ExpectedPreBlockAppHash) || !bytes.Equal(initial.AppHash(), e.Header.AppHash) {
		return nil, ErrPreBlockAppHashMismatch
	}
	// Authenticate the signed header, ordered transaction vector, and full
	// commit certificate before replay performs application work on the input.
	if err := VerifyCommitEvidence(e, validators); err != nil {
		return nil, err
	}
	replayed := initial.Clone()
	if err := replayed.Replay(e.Transactions); err != nil {
		return nil, fmt.Errorf("deterministic application replay failed: %w", err)
	}
	if anchor == nil || anchor.Header == nil || anchor.Commit == nil || anchor.Validators == nil {
		return nil, ErrMissingPostBlockAnchor
	}
	if err := verifyPostBlockAnchor(e, anchor, replayed.AppHash()); err != nil {
		return nil, err
	}
	return replayed, nil
}


func verifyPostBlockAnchor(e Evidence, anchor *PostBlockAnchor, replayedAppHash []byte) error {
	next := anchor.Header
	if e.Header == nil || e.Commit == nil || next == nil || anchor.Commit == nil || anchor.Validators == nil {
		return ErrMissingPostBlockAnchor
	}
	// The anchor commit is supplied alongside the anchor header rather than
	// derived from it, so its size must be bounded and must match the anchor
	// validator set before its entries are validated or verified.
	if anchor.Validators.Size() > MaxValidatorSetSize ||
		len(anchor.Commit.Signatures) > MaxCommitSignatures {
		return ErrSignatureVectorLength
	}
	if len(anchor.Commit.Signatures) != anchor.Validators.Size() {
		return ErrSignatureVectorLength
	}
	if e.Height == int64(^uint64(0)>>1) || next.Height != e.Height+1 ||
		next.ChainID != e.ChainID || !next.LastBlockID.Equals(e.BlockID) ||
		!bytes.Equal(next.AppHash, replayedAppHash) ||
		!bytes.Equal(next.AppHash, e.ExpectedPostBlockAppHash) ||
		!bytes.Equal(next.LastCommitHash, e.Commit.Hash()) {
		return ErrPostBlockAnchorMismatch
	}
	if err := anchor.Validators.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid next-height validator set: %w", err)
	}
	nextValidatorHash := anchor.Validators.Hash()
	if len(nextValidatorHash) == 0 ||
		!bytes.Equal(e.Header.NextValidatorsHash, nextValidatorHash) ||
		!bytes.Equal(next.ValidatorsHash, nextValidatorHash) {
		return ErrPostBlockAnchorMismatch
	}
	if err := next.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid next-height header: %w", err)
	}
	if err := anchor.BlockID.ValidateBasic(); err != nil || !anchor.BlockID.IsComplete() ||
		!bytes.Equal(next.Hash(), anchor.BlockID.Hash) {
		return ErrPostBlockAnchorMismatch
	}
	if err := anchor.Commit.ValidateBasic(); err != nil {
		return fmt.Errorf("invalid next-height commit: %w", err)
	}
	if anchor.Commit.Height != next.Height || !anchor.Commit.BlockID.Equals(anchor.BlockID) {
		return ErrPostBlockAnchorMismatch
	}
	if err := anchor.Validators.VerifyCommit(e.ChainID, anchor.BlockID, next.Height, anchor.Commit); err != nil {
		return fmt.Errorf("next-height CometBFT commit verification failed: %w", err)
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
		// Check by subtraction so the aggregate bound cannot be bypassed
		// by integer overflow on narrower architectures.
		if len(tx) > MaxBlockDataBytes-total {
			return ErrDataBounds
		}
		total += len(tx)
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
// The validator set and pre-block state hash must still be authenticated by the
// caller. This conversion-only verifier does not authenticate post-block state.
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
	// Bound the untrusted protobuf vectors before CometBFT's conversion helpers
	// allocate one Go object per element. The conversions below are linear in
	// these counts, so the bound must be enforced on the wire representation.
	if len(e.Commit.Signatures) > MaxCommitSignatures {
		return ErrSignatureVectorLength
	}
	if len(e.ValidatorSet.Validators) > MaxValidatorSetSize {
		return ErrValidatorSetBounds
	}
	if len(e.Transactions) > MaxTransactionsPerBlock {
		return ErrDataBounds
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
