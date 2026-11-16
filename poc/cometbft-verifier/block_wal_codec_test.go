package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"github.com/cometbft/cometbft/types"
)

func testWALBlockRecord() WALBlockRecord {
	record := WALBlockRecord{
		RecordNumber: 1,
		ProjectID:    "p",
		ChainID:      "zion-test-1",
		Height:       7,
		BlockID: types.BlockID{
			Hash:          bytes.Repeat([]byte{0x33}, 32),
			PartSetHeader: types.PartSetHeader{Total: 1, Hash: bytes.Repeat([]byte{0x55}, 32)},
		},
		Transactions: [][]byte{{0xaa, 0xbb}, {0xcc}},
	}
	for i := range record.GenesisDigest {
		record.GenesisDigest[i] = 0x22
	}
	for i := range record.PostBlockAppHash {
		record.PostBlockAppHash[i] = 0x44
	}
	for i := range record.CommitEvidenceDigest {
		record.CommitEvidenceDigest[i] = 0x66
	}
	return record
}

// rechecksum recomputes the trailing frame checksum so a test can present a
// structurally consistent but semantically tampered frame to the decoder.
func rechecksum(frame []byte) []byte {
	out := append([]byte(nil), frame...)
	sum := sha256.Sum256(out[:len(out)-walDigestSize])
	copy(out[len(out)-walDigestSize:], sum[:])
	return out
}

func TestWALBlockRecordCanonicalGoldenVector(t *testing.T) {
	raw, err := EncodeWALBlockRecord(testWALBlockRecord())
	if err != nil {
		t.Fatalf("encode golden block record: %v", err)
	}
	const expected = "5a57423100010000013d00000000000000010001702222222222222222222222222222222222222222222222222222222222222222000b7a696f6e2d746573742d310000000000000007333333333333333333333333333333333333333333333333333333333333333300000001555555555555555555555555555555555555555555555555555555555555555566666666666666666666666666666666666666666666666666666666666666660000000200000002aabb00000001cc1b8e636ff8101fccb8dc7ca6e20a22e60b8a8c960d2083368e836479069fba1644444444444444444444444444444444444444444444444444444444444444440000000000000000000000000000000000000000000000000000000000000000a62ac1536648b1560096cfb566c61ada67fd7eac9fb5d47daba3b554a464b62e"
	if got := hex.EncodeToString(raw); got != expected {
		t.Fatalf("canonical block WAL vector changed:\n got %s\nwant %s", got, expected)
	}
	decoded, err := DecodeWALBlockRecord(raw)
	if err != nil {
		t.Fatalf("decode golden block record: %v", err)
	}
	if decoded.RecordNumber != 1 || decoded.ProjectID != "p" || decoded.ChainID != "zion-test-1" ||
		decoded.Height != 7 || decoded.BlockID.PartSetHeader.Total != 1 ||
		len(decoded.Transactions) != 2 ||
		!bytes.Equal(decoded.Transactions[0], []byte{0xaa, 0xbb}) ||
		!bytes.Equal(decoded.Transactions[1], []byte{0xcc}) {
		t.Fatalf("decoded fields differ from golden record: %+v", decoded)
	}
}

func TestWALBlockRecordDerivesCanonicalDataHash(t *testing.T) {
	record := testWALBlockRecord()
	if record.BlockDataHash != ([walDigestSize]byte{}) {
		t.Fatal("test fixture must omit the data hash to exercise derivation")
	}
	raw, err := EncodeWALBlockRecord(record)
	if err != nil {
		t.Fatalf("encode block record: %v", err)
	}
	decoded, err := DecodeWALBlockRecord(raw)
	if err != nil {
		t.Fatalf("decode block record: %v", err)
	}
	want := types.Txs{types.Tx{0xaa, 0xbb}, types.Tx{0xcc}}.Hash()
	if !bytes.Equal(decoded.BlockDataHash[:], want) {
		t.Fatalf("derived data hash = %x, want canonical CometBFT hash %x", decoded.BlockDataHash, want)
	}
	if err := verifyTransactionData(record.Transactions, decoded.BlockDataHash[:]); err != nil {
		t.Fatalf("codec data hash disagrees with commit verification path: %v", err)
	}
}

func TestWALBlockRecordRejectsCallerSuppliedDataHashMismatch(t *testing.T) {
	record := testWALBlockRecord()
	record.BlockDataHash = [walDigestSize]byte{}
	record.BlockDataHash[0] = 0xff
	if _, err := EncodeWALBlockRecord(record); !errors.Is(err, ErrBlockWALDataHashMismatch) {
		t.Fatalf("mismatched caller data hash error = %v, want ErrBlockWALDataHashMismatch", err)
	}
}

func TestWALBlockRecordAcceptsCanonicalEmptyBlock(t *testing.T) {
	record := testWALBlockRecord()
	record.Transactions = nil
	record.BlockDataHash = [walDigestSize]byte{}
	raw, err := EncodeWALBlockRecord(record)
	if err != nil {
		t.Fatalf("encode empty block record: %v", err)
	}
	decoded, err := DecodeWALBlockRecord(raw)
	if err != nil {
		t.Fatalf("decode empty block record: %v", err)
	}
	if len(decoded.Transactions) != 0 {
		t.Fatalf("empty block decoded with %d transactions", len(decoded.Transactions))
	}
	if !bytes.Equal(decoded.BlockDataHash[:], (types.Txs{}).Hash()) {
		t.Fatal("empty block data hash is not the canonical RFC-6962 empty root")
	}
}

func TestWALBlockRecordRoundTripAndInputIsolation(t *testing.T) {
	record := testWALBlockRecord()
	raw, err := EncodeWALBlockRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeWALBlockRecord(raw)
	if err != nil {
		t.Fatal(err)
	}
	decoded.Transactions[0][0] ^= 0xff
	if record.Transactions[0][0] != 0xaa {
		t.Fatal("decoder aliased caller-owned transaction bytes")
	}
	decoded.BlockID.Hash[0] ^= 0xff
	if record.BlockID.Hash[0] != 0x33 {
		t.Fatal("decoder aliased caller-owned block ID bytes")
	}
	again, err := EncodeWALBlockRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, again) {
		t.Fatal("same block record did not encode deterministically")
	}
}

func TestWALBlockRecordRejectsReorderedTransactionsWithValidChecksum(t *testing.T) {
	record := testWALBlockRecord()
	record.Transactions = [][]byte{{0x01, 0x02}, {0x03, 0x04}}
	raw, err := EncodeWALBlockRecord(record)
	if err != nil {
		t.Fatal(err)
	}
	// Swap the two equal-length transaction payloads in place, then recompute
	// the frame checksum. The stored data hash now covers the original order.
	tampered := append([]byte(nil), raw...)
	first := bytes.Index(tampered, []byte{0x01, 0x02})
	second := bytes.Index(tampered, []byte{0x03, 0x04})
	if first < 0 || second < 0 {
		t.Fatal("test fixture did not contain the expected transaction payloads")
	}
	copy(tampered[first:first+2], []byte{0x03, 0x04})
	copy(tampered[second:second+2], []byte{0x01, 0x02})
	tampered = rechecksum(tampered)
	if _, err := DecodeWALBlockRecord(tampered); !errors.Is(err, ErrBlockWALDataHashMismatch) {
		t.Fatalf("reordered transaction error = %v, want ErrBlockWALDataHashMismatch", err)
	}
}

func TestWALBlockRecordRejectsTruncationAtEveryBoundary(t *testing.T) {
	raw, err := EncodeWALBlockRecord(testWALBlockRecord())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < len(raw); i++ {
		if _, err := DecodeWALBlockRecord(raw[:i]); err == nil {
			t.Fatalf("truncated frame of %d/%d bytes unexpectedly decoded", i, len(raw))
		}
	}
	if _, err := DecodeWALBlockRecord(append(append([]byte(nil), raw...), 0x00)); err == nil {
		t.Fatal("frame with a trailing byte unexpectedly decoded")
	}
}

func TestWALBlockRecordRejectsMalformedFrames(t *testing.T) {
	valid, err := EncodeWALBlockRecord(testWALBlockRecord())
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func([]byte) []byte
		want   error
	}{
		{"bad magic", func(b []byte) []byte { b[0] ^= 0xff; return b }, ErrInvalidBlockWALRecord},
		{"unknown version", func(b []byte) []byte { b[5] = 2; return b }, ErrInvalidBlockWALRecord},
		{"declared length mismatch", func(b []byte) []byte { b[9] ^= 0x01; return b }, ErrInvalidBlockWALRecord},
		{"checksum mismatch", func(b []byte) []byte { b[len(b)-1] ^= 0xff; return b }, ErrBlockWALChecksum},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := DecodeWALBlockRecord(tt.mutate(append([]byte(nil), valid...))); !errors.Is(err, tt.want) {
				t.Fatalf("decode error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestWALBlockRecordRejectsInvalidFieldsAndBounds(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*WALBlockRecord)
	}{
		{"zero record number", func(r *WALBlockRecord) { r.RecordNumber = 0 }},
		{"zero height", func(r *WALBlockRecord) { r.Height = 0 }},
		{"empty project", func(r *WALBlockRecord) { r.ProjectID = "" }},
		{"oversized project", func(r *WALBlockRecord) { r.ProjectID = string(bytes.Repeat([]byte("p"), maxProjectIDBytes+1)) }},
		{"NUL project", func(r *WALBlockRecord) { r.ProjectID = "a\x00b" }},
		{"empty chain ID", func(r *WALBlockRecord) { r.ChainID = "" }},
		{"oversized chain ID", func(r *WALBlockRecord) { r.ChainID = string(bytes.Repeat([]byte("c"), types.MaxChainIDLen+1)) }},
		{"NUL chain ID", func(r *WALBlockRecord) { r.ChainID = "a\x00b" }},
		{"zero genesis digest", func(r *WALBlockRecord) { r.GenesisDigest = [walDigestSize]byte{} }},
		{"zero post-block app hash", func(r *WALBlockRecord) { r.PostBlockAppHash = [walDigestSize]byte{} }},
		{"zero evidence digest", func(r *WALBlockRecord) { r.CommitEvidenceDigest = [walDigestSize]byte{} }},
		{"first record has predecessor", func(r *WALBlockRecord) { r.PreviousDigest[0] = 1 }},
		{"later record lacks predecessor", func(r *WALBlockRecord) { r.RecordNumber = 2 }},
		{"zero part-set total", func(r *WALBlockRecord) { r.BlockID.PartSetHeader.Total = 0 }},
		{"short block hash", func(r *WALBlockRecord) { r.BlockID.Hash = r.BlockID.Hash[:31] }},
		{"zero block hash", func(r *WALBlockRecord) { r.BlockID.Hash = bytes.Repeat([]byte{0}, 32) }},
		{"short part-set hash", func(r *WALBlockRecord) { r.BlockID.PartSetHeader.Hash = r.BlockID.PartSetHeader.Hash[:31] }},
		{"zero part-set hash", func(r *WALBlockRecord) { r.BlockID.PartSetHeader.Hash = bytes.Repeat([]byte{0}, 32) }},
		{"too many transactions", func(r *WALBlockRecord) {
			r.Transactions = make([][]byte, MaxTransactionsPerBlock+1)
		}},
		{"oversized transaction", func(r *WALBlockRecord) {
			r.Transactions = [][]byte{make([]byte, MaxTransactionBytes+1)}
		}},
		{"oversized aggregate", func(r *WALBlockRecord) {
			r.Transactions = make([][]byte, MaxBlockDataBytes/MaxTransactionBytes+1)
			for i := range r.Transactions {
				r.Transactions[i] = make([]byte, MaxTransactionBytes)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			record := testWALBlockRecord()
			tt.mutate(&record)
			if _, err := EncodeWALBlockRecord(record); err == nil {
				t.Fatal("invalid block WAL record unexpectedly encoded")
			}
		})
	}
}

func TestWALBlockRecordLink(t *testing.T) {
	first := testWALBlockRecord()
	firstRaw, err := EncodeWALBlockRecord(first)
	if err != nil {
		t.Fatal(err)
	}
	firstDigest := sha256.Sum256(firstRaw)
	next := testWALBlockRecord()
	next.RecordNumber = 2
	next.Height = 8
	next.PreviousDigest = firstDigest
	nextRaw, err := EncodeWALBlockRecord(next)
	if err != nil {
		t.Fatal(err)
	}
	if err := VerifyWALBlockRecordLink(firstRaw, nextRaw); err != nil {
		t.Fatalf("consecutive records rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*WALBlockRecord)
		want   error
	}{
		{"record number gap", func(r *WALBlockRecord) { r.RecordNumber = 3 }, ErrBlockWALLink},
		{"height gap", func(r *WALBlockRecord) { r.Height = 9 }, ErrBlockWALHeightRegression},
		{"height regression", func(r *WALBlockRecord) { r.Height = 7 }, ErrBlockWALHeightRegression},
		{"broken hash chain", func(r *WALBlockRecord) { r.PreviousDigest = [walDigestSize]byte{0x01} }, ErrBlockWALLink},
		{"other project", func(r *WALBlockRecord) { r.ProjectID = "other" }, ErrBlockWALLink},
		{"other genesis", func(r *WALBlockRecord) { r.GenesisDigest[0] ^= 0xff }, ErrBlockWALLink},
		{"other chain", func(r *WALBlockRecord) { r.ChainID = "zion-other-1" }, ErrBlockWALLink},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mutated := next
			tt.mutate(&mutated)
			raw, err := EncodeWALBlockRecord(mutated)
			if err != nil {
				t.Fatalf("encode mutated record: %v", err)
			}
			if err := VerifyWALBlockRecordLink(firstRaw, raw); !errors.Is(err, tt.want) {
				t.Fatalf("link error = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestSameWALBlockCommit(t *testing.T) {
	raw, err := EncodeWALBlockRecord(testWALBlockRecord())
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeWALBlockRecord(raw)
	if err != nil {
		t.Fatal(err)
	}
	again, err := DecodeWALBlockRecord(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !SameWALBlockCommit(decoded, again) {
		t.Fatal("identical committed block was not recognised as the same transition")
	}
	if SameWALBlockCommit(decoded, WALBlockRecord{}) {
		t.Fatal("zero record was treated as the same commit")
	}
	conflicting := decoded
	conflicting.BlockID.Hash = bytes.Repeat([]byte{0x77}, 32)
	if SameWALBlockCommit(decoded, conflicting) {
		t.Fatal("conflicting block ID at the same height was treated as the same commit")
	}
	conflicting = decoded
	conflicting.PostBlockAppHash[0] ^= 0xff
	if SameWALBlockCommit(decoded, conflicting) {
		t.Fatal("conflicting post-block app hash was treated as the same commit")
	}
	conflicting = decoded
	conflicting.Transactions = [][]byte{{0xaa, 0xbb}, {0xdd}}
	conflictingDataHash, err := hashedTransactionData(conflicting.Transactions)
	if err != nil {
		t.Fatal(err)
	}
	copy(conflicting.BlockDataHash[:], conflictingDataHash)
	if SameWALBlockCommit(decoded, conflicting) {
		t.Fatal("conflicting transaction payload was treated as the same commit")
	}
	conflicting = decoded
	conflicting.CommitEvidenceDigest[0] ^= 0xff
	if SameWALBlockCommit(decoded, conflicting) {
		t.Fatal("conflicting commit evidence reference was treated as the same commit")
	}
}

func FuzzDecodeWALBlockRecordCanonicalRoundTrip(f *testing.F) {
	seed, err := EncodeWALBlockRecord(testWALBlockRecord())
	if err != nil {
		f.Fatalf("encode seed: %v", err)
	}
	f.Add(seed)
	f.Add([]byte(blockWALRecordMagic))
	f.Fuzz(func(t *testing.T, raw []byte) {
		record, err := DecodeWALBlockRecord(raw)
		if err != nil {
			return
		}
		reencoded, err := EncodeWALBlockRecord(record)
		if err != nil {
			t.Fatalf("decoded record failed to re-encode: %v", err)
		}
		if !bytes.Equal(reencoded, raw) {
			t.Fatalf("canonical round trip mismatch for accepted record")
		}
	})
}
