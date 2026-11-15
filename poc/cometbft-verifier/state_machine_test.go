package verifier

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"testing"
)

func testStateTx(t *testing.T, project string, id byte, kind byte, seq uint64, key, value string) []byte {
	t.Helper()
	opID := bytes.Repeat([]byte{id}, maxOperationIDBytes)
	raw, err := EncodeStateTransaction(StateTransaction{
		ProjectID: project, OperationID: opID, Kind: kind,
		ExpectedSequence: seq, Key: []byte(key), Value: []byte(value),
	})
	if err != nil { t.Fatalf("encode state transaction: %v", err) }
	return raw
}

func newTestState(t *testing.T, project, genesis string) *StateMachine {
	t.Helper()
	digest := sha256.Sum256([]byte(genesis))
	s, err := NewStateMachine(project, digest[:])
	if err != nil { t.Fatalf("new state: %v", err) }
	return s
}

func TestStateMachineDeterministicReplayAndCanonicalHash(t *testing.T) {
	txs := [][]byte{
		testStateTx(t, "project-alpha", 1, statePut, 0, "z", "last"),
		testStateTx(t, "project-alpha", 2, statePut, 1, "a", "first"),
		testStateTx(t, "project-alpha", 3, stateDelete, 2, "z", ""),
	}
	a := newTestState(t, "project-alpha", "genesis-alpha")
	b := newTestState(t, "project-alpha", "genesis-alpha")
	if err := a.Replay(txs); err != nil { t.Fatal(err) }
	if err := b.Replay(txs); err != nil { t.Fatal(err) }
	if a.Sequence() != 3 || b.Sequence() != 3 { t.Fatalf("unexpected sequence: %d / %d", a.Sequence(), b.Sequence()) }
	if !bytes.Equal(a.AppHash(), b.AppHash()) { t.Fatal("identical replay produced different app hashes") }
}

func TestStateMachineIdempotencyAndOperationIDConflict(t *testing.T) {
	s := newTestState(t, "project-alpha", "genesis-alpha")
	tx := testStateTx(t, "project-alpha", 7, statePut, 0, "account/1", "alice")
	first, err := s.Apply(tx)
	if err != nil { t.Fatal(err) }
	hash := append([]byte(nil), s.AppHash()...)
	second, err := s.Apply(tx)
	if err != nil { t.Fatalf("identical retry rejected: %v", err) }
	if first != second || s.Sequence() != 1 || !bytes.Equal(hash, s.AppHash()) {
		t.Fatal("identical retry changed committed state")
	}
	conflict := testStateTx(t, "project-alpha", 7, statePut, 0, "account/1", "mallory")
	if _, err := s.Apply(conflict); !errors.Is(err, ErrOperationConflict) {
		t.Fatalf("expected operation conflict, got %v", err)
	}
	if s.Sequence() != 1 || !bytes.Equal(hash, s.AppHash()) { t.Fatal("conflicting retry mutated state") }
}

func TestStateMachineRejectsCrossProjectAndStaleSequenceWithoutMutation(t *testing.T) {
	s := newTestState(t, "project-alpha", "genesis-alpha")
	before := append([]byte(nil), s.AppHash()...)
	wrongProject := testStateTx(t, "project-beta", 1, statePut, 0, "k", "v")
	if _, err := s.Apply(wrongProject); !errors.Is(err, ErrWrongProject) { t.Fatalf("expected project rejection, got %v", err) }
	stale := testStateTx(t, "project-alpha", 2, statePut, 1, "k", "v")
	if _, err := s.Apply(stale); !errors.Is(err, ErrSequenceConflict) { t.Fatalf("expected sequence rejection, got %v", err) }
	if s.Sequence() != 0 || !bytes.Equal(before, s.AppHash()) { t.Fatal("rejected transaction mutated state") }
}

func TestStateMachineDeleteRequiresExistingKey(t *testing.T) {
	s := newTestState(t, "project-alpha", "genesis-alpha")
	before := append([]byte(nil), s.AppHash()...)
	missing := testStateTx(t, "project-alpha", 1, stateDelete, 0, "missing", "")
	if _, err := s.Apply(missing); !errors.Is(err, ErrMissingStateKey) { t.Fatalf("expected missing-key rejection, got %v", err) }
	if s.Sequence() != 0 || !bytes.Equal(before, s.AppHash()) { t.Fatal("rejected delete mutated state") }
}

func TestStateMachineRejectsMalformedNonCanonicalEnvelope(t *testing.T) {
	valid := testStateTx(t, "project-alpha", 1, statePut, 0, "k", "v")
	trailing := append(append([]byte(nil), valid...), 0)
	if _, err := decodeStateTransaction(trailing); !errors.Is(err, ErrInvalidTransaction) { t.Fatalf("trailing byte accepted: %v", err) }
	badMagic := append([]byte(nil), valid...)
	badMagic[0] ^= 0xff
	if _, err := decodeStateTransaction(badMagic); !errors.Is(err, ErrInvalidTransaction) { t.Fatalf("bad magic accepted: %v", err) }
}

func TestStateMachineGenesisAndProjectAreBoundIntoAppHash(t *testing.T) {
	a := newTestState(t, "project-alpha", "genesis-alpha")
	b := newTestState(t, "project-beta", "genesis-alpha")
	c := newTestState(t, "project-alpha", "genesis-other")
	if bytes.Equal(a.AppHash(), b.AppHash()) { t.Fatal("project identity missing from app hash") }
	if bytes.Equal(a.AppHash(), c.AppHash()) { t.Fatal("genesis digest missing from app hash") }
}

func TestStateMachineEmptyStateHashIsStableAndNonEmpty(t *testing.T) {
	a := newTestState(t, "project-alpha", "genesis-alpha")
	b := newTestState(t, "project-alpha", "genesis-alpha")
	if len(a.AppHash()) != sha256.Size { t.Fatalf("unexpected app hash size: %d", len(a.AppHash())) }
	if !bytes.Equal(a.AppHash(), b.AppHash()) { t.Fatal("empty state hash is not stable") }
}

func TestStateMachineRejectsSequenceOverflow(t *testing.T) {
	s := newTestState(t, "project-alpha", "genesis-alpha")
	s.sequence = ^uint64(0)
	before := append([]byte(nil), s.AppHash()...)
	tx := testStateTx(t, "project-alpha", 1, statePut, ^uint64(0), "k", "v")
	if _, err := s.Apply(tx); !errors.Is(err, ErrSequenceExhausted) {
		t.Fatalf("expected sequence exhaustion, got %v", err)
	}
	if s.Sequence() != ^uint64(0) || !bytes.Equal(before, s.AppHash()) {
		t.Fatal("sequence overflow mutated state")
	}
}
