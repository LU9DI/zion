package verifier

// This file drives the real pinned CometBFT v0.38.26 block store, state store
// and ABCI handshake replay code in order to reproduce the D5 crash windows.
//
// The only thing modelled here is the database durability boundary: a dbm.DB
// wrapper distinguishes writes that were synchronized (SetSync/DeleteSync/
// WriteSync) from writes that were merely issued (Set/Delete/Write), and can
// discard exactly the unsynchronized ones to simulate a crash. All store logic,
// all write ordering, every batch and every sync decision is the real pinned
// implementation:
//
//	store/store.go  BlockStore.SaveBlock -> saveBlockToBatch -> saveStateAndWriteDB -> batch.WriteSync()
//	state/store.go  Store.Save          -> save -> batch.WriteSync()
//	state/store.go  Store.SaveFinalizeBlockResponse -> db.Set(per height) + db.SetSync(last response)
//	state/execution.go applyBlock       -> FinalizeBlock, SaveFinalizeBlockResponse, Commit, Save
//	consensus/state.go finalizeCommit   -> SaveBlock, wal.WriteSync(EndHeight), ApplyVerifiedBlock
//	consensus/replay.go ReplayBlocks    -> the restart decision table

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
	"github.com/cometbft/cometbft/consensus"
	cmted25519 "github.com/cometbft/cometbft/crypto/ed25519"
	"github.com/cometbft/cometbft/crypto/merkle"
	"github.com/cometbft/cometbft/proxy"
	sm "github.com/cometbft/cometbft/state"
	cmtstore "github.com/cometbft/cometbft/store"
	"github.com/cometbft/cometbft/types"
	"github.com/go-kit/kit/metrics"
)

// ---------------------------------------------------------------------------
// Durability-modelling database
// ---------------------------------------------------------------------------

// durabilityModelDB is a dbm.DB whose durable layer only advances on
// synchronization. Crash() discards every write that was issued but never
// synchronized, which is the only difference between the two write classes that
// the pinned code relies on.
type durabilityModelDB struct {
	dbm.DB // the real in-memory database used for reads and iteration

	mu          sync.Mutex
	durable     map[string][]byte
	issuedSet   int
	syncedSet   int
	issuedBatch int
	syncedBatch int
}

func newDurabilityModelDB() *durabilityModelDB {
	return &durabilityModelDB{DB: dbm.NewMemDB(), durable: map[string][]byte{}}
}

func (d *durabilityModelDB) track(isSync bool, key, value []byte, deleted bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if isSync {
		d.syncedSet++
	} else {
		d.issuedSet++
	}
	if deleted {
		if isSync {
			delete(d.durable, string(key))
		}
		return
	}
	if isSync {
		d.durable[string(key)] = append([]byte(nil), value...)
	}
}

func (d *durabilityModelDB) Set(key, value []byte) error {
	d.track(false, key, value, false)
	return d.DB.Set(key, value)
}

func (d *durabilityModelDB) SetSync(key, value []byte) error {
	d.track(true, key, value, false)
	return d.DB.SetSync(key, value)
}

func (d *durabilityModelDB) Delete(key []byte) error {
	d.track(false, key, nil, true)
	return d.DB.Delete(key)
}

func (d *durabilityModelDB) DeleteSync(key []byte) error {
	d.track(true, key, nil, true)
	return d.DB.DeleteSync(key)
}

func (d *durabilityModelDB) NewBatch() dbm.Batch {
	return &durabilityModelBatch{db: d}
}

// Crash restores the database to its last synchronized contents.
func (d *durabilityModelDB) Crash() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	iterator, err := d.DB.Iterator(nil, nil)
	if err != nil {
		return err
	}
	var keys [][]byte
	for ; iterator.Valid(); iterator.Next() {
		keys = append(keys, append([]byte(nil), iterator.Key()...))
	}
	iterator.Close()
	for _, key := range keys {
		if _, ok := d.durable[string(key)]; !ok {
			if err := d.DB.Delete(key); err != nil {
				return err
			}
		}
	}
	for key, value := range d.durable {
		if err := d.DB.Set([]byte(key), value); err != nil {
			return err
		}
	}
	return nil
}

type durabilityModelBatch struct {
	db      *durabilityModelDB
	sets    map[string][]byte
	deletes map[string]bool
	closed  bool
	written bool
}

func (b *durabilityModelBatch) Set(key, value []byte) error {
	if b.closed {
		return errors.New("batch has been written or closed")
	}
	if b.sets == nil {
		b.sets = map[string][]byte{}
	}
	b.sets[string(key)] = append([]byte(nil), value...)
	return nil
}

func (b *durabilityModelBatch) Delete(key []byte) error {
	if b.closed {
		return errors.New("batch has been written or closed")
	}
	if b.deletes == nil {
		b.deletes = map[string]bool{}
	}
	b.deletes[string(key)] = true
	delete(b.sets, string(key))
	return nil
}

func (b *durabilityModelBatch) apply(sync bool) error {
	if b.closed {
		return errors.New("batch has been written or closed")
	}
	b.closed = true
	b.written = true
	if sync {
		b.db.mu.Lock()
		b.db.syncedBatch++
		b.db.mu.Unlock()
	} else {
		b.db.mu.Lock()
		b.db.issuedBatch++
		b.db.mu.Unlock()
	}
	for key, value := range b.sets {
		var err error
		if sync {
			err = b.db.SetSync([]byte(key), value)
		} else {
			err = b.db.Set([]byte(key), value)
		}
		if err != nil {
			return err
		}
	}
	for key := range b.deletes {
		var err error
		if sync {
			err = b.db.DeleteSync([]byte(key))
		} else {
			err = b.db.Delete([]byte(key))
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (b *durabilityModelBatch) Write() error     { return b.apply(false) }
func (b *durabilityModelBatch) WriteSync() error { return b.apply(true) }
func (b *durabilityModelBatch) Close() error {
	b.closed = true
	return nil
}

type nopHistogram struct{}

func (nopHistogram) With(...string) metrics.Histogram { return nopHistogram{} }
func (nopHistogram) Observe(float64)                  {}

// ---------------------------------------------------------------------------
// Application store as an ABCI application
// ---------------------------------------------------------------------------

// boundaryApp is the application store behind the real local ABCI client. It
// refuses to commit anything it could not tie to a verified block record, and it
// never persists during FinalizeBlock.
type boundaryApp struct {
	abci.BaseApplication

	store  *Store
	source *verifiedBlockSource

	staged map[int64]WALBlockRecord

	initChainCalls  int
	finalizeCalls   int
	commitCalls     int
	commitAttempts  int
	rejectedCommits int
	infoCalls       int
}

func newBoundaryApp(store *Store, source *verifiedBlockSource) *boundaryApp {
	return &boundaryApp{store: store, source: source, staged: map[int64]WALBlockRecord{}}
}

func (a *boundaryApp) Info(context.Context, *abci.RequestInfo) (*abci.ResponseInfo, error) {
	a.infoCalls++
	return &abci.ResponseInfo{
		LastBlockHeight:  int64(a.store.Height()),
		LastBlockAppHash: a.store.AppHash(),
	}, nil
}

func (a *boundaryApp) InitChain(context.Context, *abci.RequestInitChain) (*abci.ResponseInitChain, error) {
	a.initChainCalls++
	return &abci.ResponseInitChain{AppHash: a.store.AppHash()}, nil
}

func (a *boundaryApp) FinalizeBlock(_ context.Context, req *abci.RequestFinalizeBlock) (*abci.ResponseFinalizeBlock, error) {
	a.finalizeCalls++
	record, err := a.source.VerifiedBlock(uint64(req.Height))
	if err != nil {
		return nil, err
	}
	if len(record.Transactions) != len(req.Txs) {
		return nil, fmt.Errorf("decided block has %d transactions, verified record has %d",
			len(req.Txs), len(record.Transactions))
	}
	for i := range req.Txs {
		if !bytes.Equal(record.Transactions[i], req.Txs[i]) {
			return nil, fmt.Errorf("decided transaction %d differs from the verified record", i)
		}
	}
	// FinalizeBlock MUST NOT persist. The candidate state is computed on a copy.
	candidate := a.store.State()
	if err := candidate.Replay(req.Txs); err != nil {
		return nil, err
	}
	a.staged[req.Height] = record
	// One non-nil result per transaction: state.Store.SaveFinalizeBlockResponse
	// strips nil entries in place and fireEvents then indexes the shortened slice.
	results := make([]*abci.ExecTxResult, len(req.Txs))
	for i := range results {
		results[i] = &abci.ExecTxResult{Code: 0, Log: "ok"}
	}
	return &abci.ResponseFinalizeBlock{
		AppHash:   candidate.AppHash(),
		TxResults: results,
	}, nil
}

func (a *boundaryApp) Commit(context.Context, *abci.RequestCommit) (*abci.ResponseCommit, error) {
	a.commitCalls++
	height := int64(a.store.Height()) + 1
	record, ok := a.staged[height]
	if !ok {
		a.rejectedCommits++
		return nil, fmt.Errorf("commit for height %d without a staged verified block", height)
	}
	a.commitAttempts++
	if _, err := a.store.AppendBlock(record); err != nil {
		a.rejectedCommits++
		return nil, err
	}
	delete(a.staged, height)
	return &abci.ResponseCommit{}, nil
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type cometbftHarness struct {
	t        *testing.T
	cfg      StoreConfig
	db       *durabilityModelDB
	appDB    string
	appStore *Store
	app      *boundaryApp
	conns    proxy.AppConns
	genDoc   *types.GenesisDoc
	state    sm.State
}

func newCometBFTHarness(t *testing.T) *cometbftHarness {
	t.Helper()
	cfg := testStoreConfig()
	h := &cometbftHarness{t: t, cfg: cfg, db: newDurabilityModelDB(), appDB: t.TempDir()}

	// The consensus validator key is CometBFT's own Ed25519 type, which is
	// distinct from the standard library key used for genesis governor
	// manifests. The transport/committee distinction is deliberate.
	validatorKey := cmted25519.GenPrivKey()
	publicKey := validatorKey.PubKey()
	genDoc := &types.GenesisDoc{
		GenesisTime:     testGenesisTime(),
		ChainID:         cfg.ChainID,
		InitialHeight:   1,
		ConsensusParams: types.DefaultConsensusParams(),
		Validators: []types.GenesisValidator{{
			Address: publicKey.Address(),
			PubKey:  publicKey,
			Power:   10,
			Name:    "validator-0",
		}},
	}
	// The genesis application hash is what an empty application state computes,
	// so Header(1).AppHash, the application's Info hash at height 0 and the
	// genesis state agree without fabricating a value.
	genesisState, err := NewStateMachine(cfg.ProjectID, cfg.GenesisDigest)
	if err != nil {
		t.Fatalf("create genesis state machine: %v", err)
	}
	genDoc.AppHash = genesisState.AppHash()
	if err := genDoc.ValidateAndComplete(); err != nil {
		t.Fatalf("validate genesis doc: %v", err)
	}
	h.genDoc = genDoc
	genesis, err := sm.MakeGenesisState(genDoc)
	if err != nil {
		t.Fatalf("make genesis state: %v", err)
	}
	// A fresh chain's InitChain sets the empty-results Merkle root; recording it
	// here keeps the harness blocks identical to what the pinned handshake
	// validates after InitChain.
	genesis.LastResultsHash = merkle.HashFromByteSlices(nil)
	h.state = genesis
	return h
}

func testGenesisTime() time.Time { return time.Unix(1_700_000_000, 0).UTC() }

func (h *cometbftHarness) blockStore() *cmtstore.BlockStore { return cmtstore.NewBlockStore(h.db) }
func (h *cometbftHarness) stateStore() sm.Store             { return sm.NewStore(h.db, sm.StoreOptions{}) }

// openApp opens (or reopens) the application store, simulating a process restart
// of the application.
func (h *cometbftHarness) openApp(source *verifiedBlockSource) {
	h.t.Helper()
	if h.appStore != nil {
		if err := h.appStore.Close(); err != nil {
			h.t.Fatalf("close application store: %v", err)
		}
	}
	h.appStore = mustOpenStore(h.t, h.appDB, h.cfg)
	h.app = newBoundaryApp(h.appStore, source)
	// The proxy connection records ABCI method timings through a go-kit
	// histogram; a nil metrics struct dereferences it on the first call.
	h.conns = proxy.NewAppConns(proxy.NewLocalClientCreator(h.app), &proxy.Metrics{
		MethodTimingSeconds: nopHistogram{},
	})
	if err := h.conns.Start(); err != nil {
		h.t.Fatalf("start local ABCI application: %v", err)
	}
}

func (h *cometbftHarness) close() {
	if h.conns != nil {
		_ = h.conns.Stop()
	}
	if h.appStore != nil {
		_ = h.appStore.Close()
	}
	_ = h.db.Close()
}

// recordSource returns a source whose load callback is backed by the given
// records and whose verification callback is the caller's evidence check.
func recordSource(t *testing.T, records map[uint64]WALBlockRecord, verify func(WALBlockRecord) error) *verifiedBlockSource {
	t.Helper()
	if verify == nil {
		verify = func(record WALBlockRecord) error {
			if record.CommitEvidenceDigest == ([walDigestSize]byte{}) {
				return errors.New("missing commit evidence reference")
			}
			return nil
		}
	}
	source, err := NewVerifiedBlockSource(func(height uint64) (WALBlockRecord, error) {
		record, ok := records[height]
		if !ok {
			return WALBlockRecord{}, fmt.Errorf("no block stored for height %d", height)
		}
		return record, nil
	}, verify)
	if err != nil {
		t.Fatal(err)
	}
	return source
}

// buildBlock turns a ZWB1 record into a real CometBFT block whose data hash
// matches the record's exact transaction bytes.
func buildBlock(t *testing.T, record WALBlockRecord, appHash []byte, lastCommit *types.Commit) *types.Block {
	t.Helper()
	txs := make(types.Txs, len(record.Transactions))
	for i := range record.Transactions {
		txs[i] = types.Tx(append([]byte(nil), record.Transactions[i]...))
	}
	block := types.MakeBlock(int64(record.Height), txs, lastCommit, nil)
	block.Header.AppHash = append([]byte(nil), appHash...)
	return block
}

func saveBlock(t *testing.T, bs *cmtstore.BlockStore, block *types.Block) types.BlockID {
	t.Helper()
	parts, err := block.MakePartSet(types.BlockPartSizeBytes)
	if err != nil {
		t.Fatalf("make part set: %v", err)
	}
	seenCommit := &types.Commit{
		Height:  block.Height,
		Round:   0,
		BlockID: types.BlockID{Hash: block.Hash(), PartSetHeader: parts.Header()},
	}
	bs.SaveBlock(block, parts, seenCommit)
	return types.BlockID{Hash: block.Hash(), PartSetHeader: parts.Header()}
}

func (h *cometbftHarness) appHeight() int64 { return int64(h.appStore.Height()) }

// loadState re-reads the durable CometBFT state, as a restart would.
func (h *cometbftHarness) loadState() sm.State {
	h.t.Helper()
	state, err := h.stateStore().Load()
	if err != nil {
		h.t.Fatalf("load consensus state: %v", err)
	}
	h.state = state
	return state
}

// stateAtHeight builds a consistent non-genesis consensus state fixture. The
// contents are fixture data; every durability property under test comes from the
// real stores.
func (h *cometbftHarness) stateAtHeight(height int64, appHash []byte, lastBlockID types.BlockID) sm.State {
	h.t.Helper()
	genesis, err := sm.MakeGenesisState(h.genDoc)
	if err != nil {
		h.t.Fatalf("make genesis state: %v", err)
	}
	state := genesis
	state.LastBlockHeight = height
	state.LastBlockID = lastBlockID
	state.AppHash = append([]byte(nil), appHash...)
	state.LastValidators = genesis.Validators.Copy()
	state.LastBlockTime = h.genDoc.GenesisTime.Add(time.Duration(height) * time.Second)
	return state
}

// validInitialBlock builds a block at the initial height that passes the pinned
// validateBlock against the genesis state, with Header.AppHash set to the
// pre-block application hash as the ABCI contract requires.
func (h *cometbftHarness) validInitialBlock(record WALBlockRecord) *types.Block {
	h.t.Helper()
	// Block.ValidateBasic requires a non-nil LastCommit even for the initial
	// height, where it must carry no signatures.
	block := buildBlock(h.t, record, h.state.AppHash, &types.Commit{})
	block.Header.ChainID = h.state.ChainID
	block.Header.Time = h.state.LastBlockTime
	block.Header.ValidatorsHash = h.state.Validators.Hash()
	block.Header.NextValidatorsHash = h.state.NextValidators.Hash()
	block.Header.ConsensusHash = h.state.ConsensusParams.Hash()
	block.Header.LastResultsHash = h.state.LastResultsHash
	block.Header.ProposerAddress = h.state.Validators.Proposer.Address
	if err := block.ValidateBasic(); err != nil {
		h.t.Fatalf("initial block is not structurally valid: %v", err)
	}
	return block
}

// replay runs the real v0.38.26 restart decision table.
func (h *cometbftHarness) replay(infoAppHash []byte, appBlockHeight int64) ([]byte, error) {
	h.t.Helper()
	handshaker := consensus.NewHandshaker(h.stateStore(), h.state, h.blockStore(), h.genDoc)
	return handshaker.ReplayBlocks(h.state, infoAppHash, appBlockHeight, h.conns)
}
