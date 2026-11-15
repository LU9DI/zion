package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
)

func testWALRecord() WALRecord {
	record := WALRecord{
		RecordNumber: 1,
		ProjectID: "p",
		Height: 7,
		TransactionIndex: 0,
		Transaction: []byte{0xaa, 0xbb},
	}
	for i := range record.GenesisDigest { record.GenesisDigest[i] = 0x22 }
	for i := range record.BlockIDHash { record.BlockIDHash[i] = 0x33 }
	for i := range record.AppHash { record.AppHash[i] = 0x44 }
	return record
}

func TestWALRecordCanonicalGoldenVector(t *testing.T) {
	raw, err := EncodeWALRecord(testWALRecord())
	if err != nil { t.Fatalf("encode golden record: %v", err) }
	const expected = "5a574c310001000000c700000000000000010001702222222222222222222222222222222222222222222222222222222222222222000000000000000733333333333333333333333333333333333333333333333333333333333333330000000000000002aabb000000000000000000000000000000000000000000000000000000000000000044444444444444444444444444444444444444444444444444444444444444447f55fdcd6b2f5f790854b4fa3b311d046b317e227f1c3a61077cb4aefb3d2eb8"
	if got := hex.EncodeToString(raw); got != expected {
		t.Fatalf("canonical WAL vector changed:\n got %s\nwant %s", got, expected)
	}
	decoded, err := DecodeWALRecord(raw)
	if err != nil { t.Fatalf("decode golden record: %v", err) }
	if decoded.RecordNumber != 1 || decoded.ProjectID != "p" || decoded.Height != 7 ||
		decoded.TransactionIndex != 0 || !bytes.Equal(decoded.Transaction, []byte{0xaa, 0xbb}) {
		t.Fatalf("decoded fields differ from golden record: %+v", decoded)
	}
}

func TestWALRecordRoundTripAndInputIsolation(t *testing.T) {
	record := testWALRecord()
	raw, err := EncodeWALRecord(record)
	if err != nil { t.Fatal(err) }
	decoded, err := DecodeWALRecord(raw)
	if err != nil { t.Fatal(err) }
	decoded.Transaction[0] ^= 0xff
	if record.Transaction[0] != 0xaa { t.Fatal("decoder aliased caller-owned transaction bytes") }
	again, err := EncodeWALRecord(record)
	if err != nil { t.Fatal(err) }
	if !bytes.Equal(raw, again) { t.Fatal("same record did not encode deterministically") }
}

func TestWALRecordRejectsMalformedFrames(t *testing.T) {
	valid, err := EncodeWALRecord(testWALRecord())
	if err != nil { t.Fatal(err) }
	tests := []struct{name string; mutate func([]byte) []byte}{
		{"bad magic", func(b []byte) []byte { b[0] ^= 0xff; return b }},
		{"unknown version", func(b []byte) []byte { b[5] = 2; return b }},
		{"declared length too short", func(b []byte) []byte { b[9]--; return b }},
		{"trailing byte", func(b []byte) []byte { return append(b, 0) }},
		{"truncated checksum", func(b []byte) []byte { return b[:len(b)-1] }},
		{"checksum mismatch", func(b []byte) []byte { b[20] ^= 0x80; return b }},
		{"invalid UTF-8 project", func(b []byte) []byte { b[20] = 0xff; sum := sha256.Sum256(b[:len(b)-32]); copy(b[len(b)-32:], sum[:]); return b }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidate := tt.mutate(append([]byte(nil), valid...))
			if _, err := DecodeWALRecord(candidate); err == nil {
				t.Fatal("malformed WAL record unexpectedly accepted")
			}
		})
	}
	if _, err := DecodeWALRecord(bytes.Repeat([]byte{0}, MaxWALRecordBytes+1)); !errors.Is(err, ErrWALRecordBounds) {
		t.Fatalf("expected record-size bound error, got %v", err)
	}
}

func TestWALRecordRejectsInvalidFieldsAndBounds(t *testing.T) {
	base := testWALRecord()
	tests := []struct{name string; mutate func(*WALRecord)}{
		{"zero record number", func(r *WALRecord) { r.RecordNumber = 0 }},
		{"zero height", func(r *WALRecord) { r.Height = 0 }},
		{"empty project", func(r *WALRecord) { r.ProjectID = "" }},
		{"oversized project", func(r *WALRecord) { r.ProjectID = string(bytes.Repeat([]byte("x"), maxProjectIDBytes+1)) }},
		{"invalid UTF-8 project", func(r *WALRecord) { r.ProjectID = string([]byte{0xff}) }},
		{"NUL project", func(r *WALRecord) { r.ProjectID = "project\x00alpha" }},
		{"zero genesis digest", func(r *WALRecord) { r.GenesisDigest = [walDigestSize]byte{} }},
		{"zero block ID hash", func(r *WALRecord) { r.BlockIDHash = [walDigestSize]byte{} }},
		{"zero application hash", func(r *WALRecord) { r.AppHash = [walDigestSize]byte{} }},
		{"first record has predecessor", func(r *WALRecord) { r.PreviousDigest[0] = 1 }},
		{"later record lacks predecessor", func(r *WALRecord) { r.RecordNumber = 2 }},
		{"transaction index out of range", func(r *WALRecord) { r.TransactionIndex = MaxTransactionsPerBlock }},
		{"oversized transaction", func(r *WALRecord) { r.Transaction = bytes.Repeat([]byte("x"), MaxTransactionBytes+1) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			record := base
			tt.mutate(&record)
			if _, err := EncodeWALRecord(record); err == nil {
				t.Fatal("invalid WAL fields unexpectedly encoded")
			}
		})
	}
}

func TestWALRecordHashChainRequiresSequenceAndDigestContinuity(t *testing.T) {
	first := testWALRecord()
	firstRaw, err := EncodeWALRecord(first)
	if err != nil { t.Fatal(err) }
	firstDigest, err := WALRecordDigest(firstRaw)
	if err != nil { t.Fatal(err) }

	second := first
	second.RecordNumber = 2
	second.TransactionIndex = 1
	second.Transaction = []byte("next transaction")
	second.PreviousDigest = firstDigest
	second.AppHash[0] ^= 0x01
	secondRaw, err := EncodeWALRecord(second)
	if err != nil { t.Fatal(err) }
	if err := VerifyWALRecordLink(firstRaw, secondRaw); err != nil {
		t.Fatalf("valid WAL link rejected: %v", err)
	}

	wrongDigest := second
	wrongDigest.PreviousDigest[0] ^= 0xff
	wrongDigestRaw, err := EncodeWALRecord(wrongDigest)
	if err != nil { t.Fatal(err) }
	if err := VerifyWALRecordLink(firstRaw, wrongDigestRaw); !errors.Is(err, ErrWALLink) {
		t.Fatalf("expected hash-chain rejection, got %v", err)
	}

	wrongSequence := second
	wrongSequence.RecordNumber = 3
	wrongSequenceRaw, err := EncodeWALRecord(wrongSequence)
	if err != nil { t.Fatal(err) }
	if err := VerifyWALRecordLink(firstRaw, wrongSequenceRaw); !errors.Is(err, ErrWALLink) {
		t.Fatalf("expected sequence rejection, got %v", err)
	}
}
