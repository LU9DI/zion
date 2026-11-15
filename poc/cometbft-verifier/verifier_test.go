package verifier

import (
	"bytes"
	"errors"
	"testing"
	"time"

	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	cmtversion "github.com/cometbft/cometbft/proto/tendermint/version"
	"github.com/cometbft/cometbft/crypto/tmhash"
	"github.com/cometbft/cometbft/types"
	cmtversionpkg "github.com/cometbft/cometbft/version"
)

const testChainID = "zion-verifier-test-1"

func signedEvidence(t *testing.T) (Evidence, *types.ValidatorSet) {
	t.Helper()
	validators, privateValidators := types.RandValidatorSet(4, 1)
	const height int64 = 7
	initialState := newTestState(t, "project-alpha", "genesis-alpha")
	transactions := [][]byte{
		testStateTx(t, "project-alpha", 1, statePut, 0, "account/1", "alice"),
		testStateTx(t, "project-alpha", 2, statePut, 1, "account/2", "bob"),
		testStateTx(t, "project-alpha", 3, stateDelete, 2, "account/1", ""),
	}
	finalState := initialState.Clone()
	if err := finalState.Replay(transactions); err != nil {
		t.Fatalf("replay signed test transactions: %v", err)
	}
	appHash := finalState.AppHash()
	cometTxs := make(types.Txs, len(transactions))
	for i := range transactions {
		cometTxs[i] = append(types.Tx(nil), transactions[i]...)
	}
	proposerAddress, _ := validators.GetByIndex(0)
	header := &types.Header{
		Version:            cmtversion.Consensus{Block: cmtversionpkg.BlockProtocol},
		ChainID:             testChainID,
		Height:              height,
		Time:                time.Unix(1_700_000_000, 0).UTC(),
		ValidatorsHash:      append([]byte(nil), validators.Hash()...),
		NextValidatorsHash:  append([]byte(nil), validators.Hash()...),
		ConsensusHash:       tmhash.Sum([]byte("consensus params")),
		AppHash:             append([]byte(nil), appHash...),
		LastResultsHash:     tmhash.Sum([]byte("last results")),
		LastCommitHash:      tmhash.Sum([]byte("last commit")),
		DataHash:            append([]byte(nil), cometTxs.Hash()...),
		EvidenceHash:        tmhash.Sum([]byte("evidence")),
		ProposerAddress:     append([]byte(nil), proposerAddress...),
	}
	blockID := types.BlockID{
		Hash: header.Hash(),
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
			Round:            0,
			BlockID:          blockID,
			Timestamp:        time.Unix(1_700_000_010+int64(i), 0).UTC(),
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
		ExpectedAppHash:  append([]byte(nil), appHash...),
		Transactions:     cloneTransactions(transactions),
		Header:           header,
		Commit:           commit,
	}, validators
}

func cloneTransactions(in [][]byte) [][]byte {
	out := make([][]byte, len(in))
	for i := range in {
		out[i] = append([]byte(nil), in[i]...)
	}
	return out
}

func cloneEvidence(in Evidence) Evidence {
	out := in
	out.ValidatorSetHash = append([]byte(nil), in.ValidatorSetHash...)
	out.ExpectedAppHash = append([]byte(nil), in.ExpectedAppHash...)
	out.Transactions = cloneTransactions(in.Transactions)
	headerCopy := *in.Header
	headerCopy.ValidatorsHash = append([]byte(nil), in.Header.ValidatorsHash...)
	headerCopy.NextValidatorsHash = append([]byte(nil), in.Header.NextValidatorsHash...)
	headerCopy.ConsensusHash = append([]byte(nil), in.Header.ConsensusHash...)
	headerCopy.AppHash = append([]byte(nil), in.Header.AppHash...)
	headerCopy.LastResultsHash = append([]byte(nil), in.Header.LastResultsHash...)
	headerCopy.LastCommitHash = append([]byte(nil), in.Header.LastCommitHash...)
	headerCopy.DataHash = append([]byte(nil), in.Header.DataHash...)
	headerCopy.EvidenceHash = append([]byte(nil), in.Header.EvidenceHash...)
	headerCopy.ProposerAddress = append([]byte(nil), in.Header.ProposerAddress...)
	out.Header = &headerCopy
	commitCopy := *in.Commit
	out.Commit = &commitCopy
	out.Commit.Signatures = append([]types.CommitSig(nil), in.Commit.Signatures...)
	for i := range out.Commit.Signatures {
		out.Commit.Signatures[i].ValidatorAddress = append([]byte(nil), in.Commit.Signatures[i].ValidatorAddress...)
		out.Commit.Signatures[i].Signature = append([]byte(nil), in.Commit.Signatures[i].Signature...)
	}
	return out
}

func TestVerifyCommitEvidenceAcceptsValidFourValidatorCommitHeaderAndOrderedTransactions(t *testing.T) {
	evidence, validators := signedEvidence(t)
	if err := VerifyCommitEvidence(evidence, validators); err != nil {
		t.Fatalf("valid commit/header/transactions rejected: %v", err)
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
		{"header chain ID mismatch", func(e *Evidence) { e.Header.ChainID = "other-chain" }},
		{"header height mismatch", func(e *Evidence) { e.Header.Height++ }},
		{"header hash does not match committed block ID", func(e *Evidence) { e.Header.AppHash = tmhash.Sum([]byte("substituted app hash")) }},
		{"header validator hash mismatch", func(e *Evidence) { e.Header.ValidatorsHash = tmhash.Sum([]byte("substituted validators")) }},
		{"independently expected app hash mismatch", func(e *Evidence) { e.ExpectedAppHash = tmhash.Sum([]byte("wrong state root")) }},
		{"validator set digest mismatch", func(e *Evidence) { e.ValidatorSetHash[0] ^= 0xff }},
		{"altered transaction bytes", func(e *Evidence) { e.Transactions[0][0] ^= 0xff }},
		{"omitted transaction", func(e *Evidence) { e.Transactions = e.Transactions[:2] }},
		{"reordered transactions", func(e *Evidence) {
			e.Transactions[0], e.Transactions[1] = e.Transactions[1], e.Transactions[0]
		}},
		{"cross-project transaction replay", func(e *Evidence) {
			e.Transactions[0] = []byte("project-beta|op-0001|PUT|account/1|mallory")
		}},
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

func TestVerifyTransactionDataAcceptsCanonicalEmptyBlock(t *testing.T) {
	canonicalEmptyDataHash := (types.Txs{}).Hash()
	if len(canonicalEmptyDataHash) == 0 {
		t.Fatal("CometBFT canonical empty data hash unexpectedly empty")
	}
	if err := verifyTransactionData(nil, canonicalEmptyDataHash); err != nil {
		t.Fatalf("canonical empty block data rejected: %v", err)
	}
	if err := verifyTransactionData(nil, nil); !errors.Is(err, ErrDataHashMismatch) {
		t.Fatalf("nil data hash must not be accepted as canonical empty block hash, got %v", err)
	}
}

func TestVerifyTransactionDataRejectsOversizedEvidence(t *testing.T) {
	oversized := bytes.Repeat([]byte("x"), MaxTransactionBytes+1)
	if err := verifyTransactionData([][]byte{oversized}, []byte("irrelevant")); !errors.Is(err, ErrDataBounds) {
		t.Fatalf("expected transaction bound error, got %v", err)
	}
	tooMany := make([][]byte, MaxTransactionsPerBlock+1)
	if err := verifyTransactionData(tooMany, []byte("irrelevant")); !errors.Is(err, ErrDataBounds) {
		t.Fatalf("expected transaction count bound error, got %v", err)
	}
}

func TestVerifyCommitEvidenceRejectsMissingOrMalformedEnvelope(t *testing.T) {
	evidence, validators := signedEvidence(t)
	if err := VerifyCommitEvidence(Evidence{}, validators); !errors.Is(err, ErrMissingEvidence) {
		t.Fatalf("expected missing evidence error, got %v", err)
	}
	evidence.Header = nil
	if err := VerifyCommitEvidence(evidence, validators); !errors.Is(err, ErrMissingEvidence) {
		t.Fatalf("expected missing header error, got %v", err)
	}
	evidence, _ = signedEvidence(t)
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
		ChainID:               evidence.ChainID,
		Height:                evidence.Height,
		BlockID:               &blockIDProto,
		Header:                evidence.Header.ToProto(),
		ValidatorSet:          validatorProto,
		ExpectedValidatorHash: append([]byte(nil), evidence.ValidatorSetHash...),
		ExpectedAppHash:       append([]byte(nil), evidence.ExpectedAppHash...),
		Transactions:          cloneTransactions(evidence.Transactions),
		Commit:                evidence.Commit.ToProto(),
	}
	if err := VerifyProtoCommitEvidence(wire); err != nil {
		t.Fatalf("valid protobuf evidence rejected: %v", err)
	}
	wire.ExpectedValidatorHash[0] ^= 0xff
	if err := VerifyProtoCommitEvidence(wire); !errors.Is(err, ErrValidatorSetMismatch) {
		t.Fatalf("expected authenticated validator hash mismatch, got %v", err)
	}
	wire.ExpectedValidatorHash = append([]byte(nil), evidence.ValidatorSetHash...)
	wire.Transactions[1][0] ^= 0xff
	if err := VerifyProtoCommitEvidence(wire); !errors.Is(err, ErrDataHashMismatch) {
		t.Fatalf("expected protobuf transaction data mismatch, got %v", err)
	}
}

func TestVerifyCommitEvidenceRejectsUnknownValidatorSignature(t *testing.T) {
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
	beforeHeaderHash := append([]byte(nil), evidence.Header.Hash()...)
	beforeTransactions := cloneTransactions(evidence.Transactions)
	if err := VerifyCommitEvidence(evidence, validators); err != nil {
		t.Fatalf("valid commit rejected: %v", err)
	}
	if !bytes.Equal(beforeHash, evidence.Commit.Hash()) {
		t.Fatal("verifier mutated the commit")
	}
	if !bytes.Equal(beforeHeaderHash, evidence.Header.Hash()) {
		t.Fatal("verifier mutated the header")
	}
	for i := range beforeTransactions {
		if !bytes.Equal(beforeTransactions[i], evidence.Transactions[i]) {
			t.Fatalf("verifier mutated transaction %d", i)
		}
	}
}
