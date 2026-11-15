package verifier

import (
	"bytes"
	"errors"
	"testing"
	"time"

	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/cometbft/cometbft/crypto/tmhash"
	"github.com/cometbft/cometbft/types"
)

const testChainID = "zion-verifier-test-1"

func signedEvidence(t *testing.T) (Evidence, *types.ValidatorSet) {
	t.Helper()
	validators, privateValidators := types.RandValidatorSet(4, 1)
	const height int64 = 7
	blockID := types.BlockID{
		Hash: tmhash.Sum([]byte("test block")),
		PartSetHeader: types.PartSetHeader{
			Total: 1,
			Hash:  tmhash.Sum([]byte("test parts")),
		},
	}

	signatures := make([]types.CommitSig, validators.Size())
	for i := 0; i < validators.Size(); i++ {
		address, _ := validators.GetByIndex(int32(i))
		vote := &types.Vote{
			Type:             cmtproto.PrecommitType,
			Height:           height,
			Round:             0,
			BlockID:          blockID,
			Timestamp:        time.Unix(1_700_000_000+int64(i), 0).UTC(),
			ValidatorAddress: address,
			ValidatorIndex:   int32(i),
		}
		if _, err := types.SignAndCheckVote(vote, privateValidators[i], testChainID, false); err != nil {
			t.Fatalf("sign vote %d: %v", i, err)
		}
		signatures[i] = vote.CommitSig()
	}

	commit := &types.Commit{
		Height:     height,
		Round:      0,
		BlockID:    blockID,
		Signatures: signatures,
	}
	return Evidence{
		ChainID:          testChainID,
		Height:           height,
		BlockID:          blockID,
		ValidatorSetHash: append([]byte(nil), validators.Hash()...),
		Commit:           commit,
	}, validators
}

func cloneEvidence(in Evidence) Evidence {
	out := in
	out.ValidatorSetHash = append([]byte(nil), in.ValidatorSetHash...)
	commitCopy := *in.Commit
	out.Commit = &commitCopy
	out.Commit.Signatures = append([]types.CommitSig(nil), in.Commit.Signatures...)
	for i := range out.Commit.Signatures {
		out.Commit.Signatures[i].ValidatorAddress = append([]byte(nil), in.Commit.Signatures[i].ValidatorAddress...)
		out.Commit.Signatures[i].Signature = append([]byte(nil), in.Commit.Signatures[i].Signature...)
	}
	return out
}

func TestVerifyCommitEvidenceAcceptsValidFourValidatorCommit(t *testing.T) {
	evidence, validators := signedEvidence(t)
	if err := VerifyCommitEvidence(evidence, validators); err != nil {
		t.Fatalf("valid commit rejected: %v", err)
	}
}

func TestVerifyCommitEvidenceRejectsInvalidEvidence(t *testing.T) {
	base, validators := signedEvidence(t)
	tests := []struct {
		name   string
		mutate func(*Evidence)
	}{
		{"wrong chain ID", func(e *Evidence) { e.ChainID = "other-chain" }},
		{"wrong height", func(e *Evidence) { e.Height++ }},
		{"wrong block ID", func(e *Evidence) { e.BlockID.Hash = tmhash.Sum([]byte("substituted block")) }},
		{"validator set digest mismatch", func(e *Evidence) { e.ValidatorSetHash[0] ^= 0xff }},
		{"altered signature", func(e *Evidence) { e.Commit.Signatures[0].Signature[0] ^= 0xff }},
		{"signature copied into another validator slot", func(e *Evidence) {
			e.Commit.Signatures[1].Signature = append([]byte(nil), e.Commit.Signatures[0].Signature...)
		}},
		{"short signature vector", func(e *Evidence) {
			e.Commit.Signatures = e.Commit.Signatures[:len(e.Commit.Signatures)-1]
		}},
		{"insufficient voting power", func(e *Evidence) {
			e.Commit.Signatures[2] = types.NewCommitSigAbsent()
			e.Commit.Signatures[3] = types.NewCommitSigAbsent()
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			evidence := cloneEvidence(base)
			tt.mutate(&evidence)
			if err := VerifyCommitEvidence(evidence, validators); err == nil {
				t.Fatal("invalid evidence unexpectedly accepted")
			}
		})
	}
}

func TestVerifyCommitEvidenceRejectsMissingOrMalformedEnvelope(t *testing.T) {
	evidence, validators := signedEvidence(t)
	if err := VerifyCommitEvidence(Evidence{}, validators); !errors.Is(err, ErrMissingEvidence) {
		t.Fatalf("expected missing evidence error, got %v", err)
	}
	evidence.ChainID = ""
	if err := VerifyCommitEvidence(evidence, validators); !errors.Is(err, ErrInvalidChainID) {
		t.Fatalf("expected chain ID error, got %v", err)
	}
	evidence.ChainID = testChainID
	evidence.ValidatorSetHash = nil
	if err := VerifyCommitEvidence(evidence, validators); !errors.Is(err, ErrValidatorSetMismatch) {
		t.Fatalf("expected validator set mismatch, got %v", err)
	}
}

func TestVerifyProtoCommitEvidence(t *testing.T) {
	evidence, validators := signedEvidence(t)
	validatorProto, err := validators.ToProto()
	if err != nil {
		t.Fatalf("encode validator set: %v", err)
	}
	blockIDProto := evidence.BlockID.ToProto()
	wire := ProtoEvidence{
		ChainID:              evidence.ChainID,
		Height:               evidence.Height,
		BlockID:              &blockIDProto,
		ValidatorSet:         validatorProto,
		ExpectedValidatorHash: append([]byte(nil), evidence.ValidatorSetHash...),
		Commit:               evidence.Commit.ToProto(),
	}
	if err := VerifyProtoCommitEvidence(wire); err != nil {
		t.Fatalf("valid protobuf evidence rejected: %v", err)
	}
	wire.ExpectedValidatorHash[0] ^= 0xff
	if err := VerifyProtoCommitEvidence(wire); !errors.Is(err, ErrValidatorSetMismatch) {
		t.Fatalf("expected authenticated validator hash mismatch, got %v", err)
	}
}

func TestVerifyProtoCommitEvidenceRejectsUnknownValidatorSignature(t *testing.T) {
	evidence, validators := signedEvidence(t)
	outsider, outsiderPrivate := types.RandValidator(false, 1)
	vote := &types.Vote{
		Type:             cmtproto.PrecommitType,
		Height:           evidence.Height,
		Round:            0,
		BlockID:          evidence.BlockID,
		Timestamp:        time.Unix(1_700_000_100, 0).UTC(),
		ValidatorAddress: outsider.Address,
		ValidatorIndex:   0,
	}
	if _, err := types.SignAndCheckVote(vote, outsiderPrivate, testChainID, false); err != nil {
		t.Fatalf("sign outsider vote: %v", err)
	}
	evidence.Commit.Signatures[0] = vote.CommitSig()
	if err := VerifyCommitEvidence(evidence, validators); err == nil {
		t.Fatal("commit containing an unknown validator signature unexpectedly accepted")
	}
}

func TestVerifyCommitEvidenceDoesNotMutateInputs(t *testing.T) {
	evidence, validators := signedEvidence(t)
	beforeHash := append([]byte(nil), evidence.Commit.Hash()...)
	if err := VerifyCommitEvidence(evidence, validators); err != nil {
		t.Fatalf("valid commit rejected: %v", err)
	}
	if !bytes.Equal(beforeHash, evidence.Commit.Hash()) {
		t.Fatal("verifier mutated the commit")
	}
}
