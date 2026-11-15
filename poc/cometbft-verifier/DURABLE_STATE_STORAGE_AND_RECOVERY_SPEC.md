# Durable State Storage and Recovery Protocol (PoC Specification)

**Status:** design specification; D1 pure codec has been added to the isolated PoC and its validation CI on PR head b6c83192a2cbe9d07722647bae7b65be9b303c82 completed successfully. Review identified a block-completeness gap; D1 remains codec-only and no filesystem persistence is implemented.  
**Scope:** isolated CometBFT verifier/replay PoC under `poc/cometbft-verifier/`.  
**Non-goal:** this document does not authorize production Zion integration, invitation admission, validator operation, or a deployment.

## 1. Current boundary

The in-memory `StateMachine` and canonical `ZST1` snapshot codec provide deterministic replay and bounded serialization. They do not provide durable persistence, crash recovery, process exclusion, rollback resistance, or atomic coupling to CometBFT's block store.

A valid snapshot checksum proves only that the bytes match their embedded checksum. It does not prove who produced the snapshot, whether it is the newest snapshot, or whether the state corresponds to a committed block.

## 2. Required invariants

A future storage adapter must preserve all of the following:

1. **Project/genesis binding:** every durable record is bound to one exact project ID and authenticated genesis digest.
2. **Monotonic committed height:** the adapter never silently replaces a later committed state with an earlier state.
3. **State-root agreement:** a recovered state is accepted only when its computed application hash agrees with independently verified commit evidence at the same height.
4. **No partial visibility:** readers see either the previous complete durable generation or the next complete durable generation, never a partially written snapshot.
5. **Write ordering:** data required to recover a commit reaches stable storage before the adapter publishes that commit as locally durable.
6. **Idempotent replay:** replaying the same committed block after a crash has no additional effect; a conflicting block at an already committed height fails closed.
7. **Single writer:** only one process may mutate a project's local store at a time. Lock ownership must not be inferred from a stale PID alone.
8. **Bounded recovery:** all record sizes, counts, replay work, and recovery time have explicit limits. Exceeding a limit produces a visible recovery error, not a partial state.
9. **No trust by discovery:** a file, directory, peer, DHT record, RPC response, or snapshot checksum is not a trust anchor.
10. **Fail closed on ambiguity:** unknown schema, torn/corrupt record, conflicting history, missing commit evidence, or uncertain durability prevents the node from reporting the state as current/trusted.

## 3. Separation of three artifacts

The implementation must keep these concepts distinct:

- **WAL (write-ahead log):** locally durable, ordered application transitions and their exact input transaction bytes.
- **Snapshot:** a compact state checkpoint used to accelerate recovery. It is a cache of replayable state, not an authority.
- **Commit evidence:** independently verifiable evidence that CometBFT committed a particular block under the authenticated validator set, together with the expected application hash.

A WAL entry or snapshot alone must never be interpreted as a quorum commit certificate.

## 4. Proposed on-disk layout

Use one directory per project and genesis identity, with strict permissions and no symlink-following during file creation/open:

```text
store/
  LOCK
  FORMAT
  wal/
    segment-0000000000000001.log
    segment-0000000000000002.log
  snapshots/
    snapshot-0000000000000042.zst
  generations/
    generation-0000000000000042.manifest
  CURRENT
  quarantine/
```

Names are illustrative, not a stable API. A generation manifest binds the snapshot digest, project ID, genesis digest, committed height, block ID, application hash, WAL segment/offset, schema version, and the commit-evidence reference/digest. `CURRENT` is only a pointer to a complete generation; it is not itself a trust anchor.

All paths must be resolved beneath the configured store root. Reject symlinks, path traversal, unexpected file types, duplicate generation identifiers, and files exceeding configured limits. The exact Windows ACL and POSIX permission implementations must be separately reviewed and tested; a portable mode bit is not an adequate substitute for Windows ACL verification.

## 5. WAL record framing

A future versioned WAL record should include:

- fixed magic and format version;
- bounded total record length;
- monotonically increasing local record number;
- project ID and genesis digest;
- CometBFT height and block ID;
- transaction index and exact transaction bytes (or a bounded reference to an immutable block payload);
- previous-record digest;
- resulting application hash;
- checksum over the canonical record bytes.

All integers use a single specified byte order. The decoder must reject unknown versions, non-canonical encodings, integer overflow, truncated fields, oversized lengths, trailing bytes, invalid digest links, wrong project/genesis, and non-monotonic record numbers.

A checksum/hash chain detects accidental damage and some local edits; it does **not** authenticate a writer or prevent an attacker from rewriting the entire chain. Authentication comes from independently verified consensus evidence, not from the local WAL hash chain.\n\n### D1 codec wire format\n\nThe current isolated codec in `wal_codec.go` defines `ZWL1` version 1 as the following exact sequence: magic (4 bytes), version (u16), total frame length including checksum (u32), record number (u64), project ID length (u16), UTF-8 project ID bytes, genesis digest (32), height (u64), block ID hash (32), block part-set total (u32), block part-set hash (32), transaction index (u32), transaction length (u32), exact transaction bytes, previous-record digest (32), resulting app hash (32), and SHA-256 checksum (32) over every preceding byte. All integers are big-endian. The current limits are 2 MiB per encoded frame, 128 project-ID bytes, `MaxTransactionBytes` per transaction, and transaction index below `MaxTransactionsPerBlock`. Record number and height must be nonzero; genesis, block-ID, and app hashes must be nonzero; record 1 must have a zero predecessor digest, while later records must have a nonzero predecessor digest. The decoder requires exact total length and rejects trailing bytes, unsupported versions, invalid UTF-8/NUL project IDs, malformed lengths, and checksum mismatch. `WALRecordDigest` validates before hashing the complete frame; `VerifyWALRecordLink` checks adjacent record number, project/genesis continuity, nondecreasing height, and previous-record digest. These helpers validate encoding and local chain continuity only; they do not verify commit evidence or authenticate the record source.



## 5.1 D2 format gate: block-atomic WAL records

Review of D1 identified a semantic mismatch that must be resolved before filesystem persistence:

- ZWL1 v1 stores one transaction per record and includes an application hash.
- A CometBFT commit identifies a complete block, not an independently committed transaction. The block's application result is meaningful only after the complete ordered transaction list (including the empty-block case) has been processed under the application's block lifecycle.
- Consequently, the v1 per-transaction AppHash field is ambiguous: it could be mistaken for an intermediate per-transaction state hash or for the final block application hash. Neither interpretation currently proves that the record contains the complete committed block.
- TransactionIndex alone does not prove completeness. The format does not bind the total transaction count or the block's canonical DataHash, and it has no explicit block-complete/commit boundary.

**Decision for D2:** do not append ZWL1 records to a durable store and do not use ZWL1 as a recovery authority. Preserve D1 as a pure codec/golden-vector exercise. D2 must introduce a new versioned, block-atomic WAL envelope (provisionally ZWB1) or an equivalently explicit block container. One logical WAL commit must bind:

1. project ID and authenticated genesis digest;
2. monotonically increasing local WAL record number and previous-record digest;
3. CometBFT height and the complete BlockID (block hash plus part-set total and hash);
4. canonical block transaction count, canonical DataHash, and every exact transaction byte string in original order, with aggregate and per-item size/count bounds;
5. the expected post-block application hash;
6. a digest/reference to independently verified commit evidence, plus enough canonical block/header identity to prevent substituting evidence for another block.

The codec must reject a transaction count/list mismatch, DataHash mismatch, reordered or substituted transactions, duplicate/trailing bytes, invalid BlockID fields, overflow, and resource-limit violations. The verifier must independently recompute the canonical block DataHash using the exact pinned CometBFT version's rules; it must not trust a caller-supplied DataHash merely because it is included in a checksummed record.

D2 replay must be block-atomic: clone the last accepted state, apply the entire ordered block transaction list to the disposable copy, execute any explicitly modeled end-of-block transition, compare the resulting app hash with the verified expected post-block hash, and only then make the candidate state eligible for durable publication. A failed transaction or failed hash/evidence check discards the entire candidate state. Replaying an identical already-committed block is idempotent; a different BlockID or transaction payload at the same committed height is a hard conflict.

The commit-evidence digest is only a lookup/binding aid. The actual evidence must be retained or retrievable from a separately trusted source and re-verified during recovery against the authenticated validator-set history. A hash, local WAL checksum, or locally stored proof blob is not by itself a trust anchor.

No D2 implementation may begin until both gates in §5.1 are satisfied: the verifier's pre-/post-block app-hash semantics are corrected and tested, and the exact pinned CometBFT version's block encoding, DataHash calculation, BlockID construction, commit verification, and application lifecycle are inspected and captured in executable golden tests. If a safe canonical full-block representation cannot be established, stop at the pure codec stage rather than approximating it.



### Header AppHash is the pre-block application state

A second, more fundamental issue was found by inspecting the pinned verifier's evidence model against CometBFT's Header semantics. In CometBFT v0.38.26, Header.AppHash is the application hash returned after executing and committing the **previous** block. The current block's DataHash commits its ordered transactions, but Header.AppHash is not the result of executing those transactions.

Before the corrective commit, the PoC verifier and its signed-evidence fixture incorrectly set Header.AppHash equal to the state hash obtained after replaying the transactions in that same block. The verifier and fixtures first changed to carry distinct ExpectedPreBlockAppHash and ExpectedPostBlockAppHash values. A subsequent hardening change now also requires a PostBlockAnchor: the signed H+1 header must point back to the H BlockID, carry the replayed H post-state as its AppHash, be signed by the validator set committed in Header(H).NextValidatorsHash, and pass full CometBFT commit verification at H+1. Tests cover missing anchor, wrong next height, validator-transition mismatch, and wrong post-state. The dedicated CometBFT v0.38.26 verifier job (Go tests and go vet) passed on code commit 1f52e9d35a714dcef222426051b5097de057526e. Broader repository validation and CodeQL were still running at the last check; do not treat the whole PR as fully validated until those jobs complete on the corresponding code state.

Before any D2 implementation, split the verifier's state bindings explicitly:

- **Pre-block state:** the trusted state at the start of height H. Its app hash must equal Header(H).AppHash.
- **Block input:** the exact ordered transaction list for block H. Its canonical DataHash must equal Header(H).DataHash.
- **Post-block state:** the result of executing block H under the pinned CometBFT/ABCI lifecycle. Its app hash must be compared with an independently authenticated post-block expectation, such as Header(H+1).AppHash after verifying the next header/commit and its validator-set transition, or a separately specified authenticated application-commit evidence path. Do not compare it to Header(H).AppHash.

The test-only StateMachine currently models only ordered transaction mutations; it does not model the full ABCI++ FinalizeBlock/Commit lifecycle, block evidence processing, validator/consensus parameter updates, or end-block hooks. Until those omissions are explicitly bounded or modeled, its post-block hash is only the result of this simplified application model, not a complete CometBFT application state transition.

Required corrective gate:
1. The verifier checks the pre-block app hash against Header(H).AppHash and uses a distinct post-block hash.
2. Signed fixtures now bind the post-block hash to a fully signed H+1 header whose LastBlockID points to H, whose LastCommitHash binds the H commit, whose AppHash equals the replay result, and whose validator set is committed by Header(H).NextValidatorsHash.
3. Tests now cover wrong pre-state, wrong post-state, missing next-height anchor, wrong next height, and validator-transition mismatch. CI must confirm this implementation.
4. The remaining trust-bootstrap requirement is to define the authenticated genesis/InitChain app hash and the validator-set history at the initial height. The next-header chain can extend a trusted checkpoint but cannot create the initial trust anchor itself.
5. Only after those tests pass and the genesis trust bootstrap is specified may the block-atomic WAL format proceed. A D1 checksum, block DataHash, or commit certificate alone does not authenticate the resulting application state.

This gate supersedes any wording above that could be read as allowing the current Header(H).AppHash to serve as the expected post-block state hash.

## 6. Commit and fsync ordering

The storage adapter must expose an explicit commit operation rather than allowing callers to mutate the durable state directly. The conceptual order is:

1. Verify the block's commit evidence and validator-set trust chain, or receive an equivalent verified result from a clearly defined trusted boundary.
2. Replay the exact ordered transactions against a disposable copy of the last accepted state.
3. Verify the computed application hash against the expected hash in the verified block/header evidence.
4. Append a complete, framed WAL commit record containing block identity, transaction bytes/references, resulting sequence and application hash.
5. Flush the WAL file and request stable-storage synchronization.
6. Write a new snapshot/generation to a temporary file in the target filesystem; flush it; atomically publish it using a platform-appropriate replacement operation; synchronize the containing directory where supported.
7. Write and durably publish the generation manifest, then update `CURRENT` using an atomic replacement protocol.
8. Only after all required durability steps succeed may this adapter report the generation as locally durable.

This sequence is a design target, not a claim that ordinary filesystem APIs provide identical guarantees on every filesystem, operating system, storage controller, or virtualized disk. The implementation must document the exact guarantee it relies on and fail closed when a required operation is unavailable.

The snapshot may be written less frequently than the WAL. WAL truncation/compaction is forbidden until a newer snapshot and its manifest have been durably published and verified by reopening them.

## 7. Crash recovery state machine

Recovery must be explicit and observable:

- **UNINITIALIZED:** no trusted genesis/checkpoint is configured. Do not accept a local snapshot as authority.
- **RECOVERING:** acquire the exclusive process lock, inspect bounded metadata, verify format and project/genesis binding, and scan WAL records.
- **SNAPSHOT_VALIDATED:** a snapshot passes structural, checksum, and app-hash checks against the configured expected project/genesis. This is not yet a trusted current state.
- **REPLAYING:** replay complete WAL commits after the snapshot, in strict height/order sequence, verifying each block's independently authenticated commit evidence and resulting app hash.
- **CURRENT_TRUSTED:** recovered height/hash agrees with the authenticated CometBFT history and all required durability checks pass.
- **STALE_OR_INCOMPLETE:** local data is valid but does not reach the required trusted height. Continue only through a separately specified authenticated sync/replay path.
- **QUARANTINED:** conflicting block identity, invalid commit evidence, broken hash chain, rollback indication, project/genesis mismatch, or ambiguous torn record. Do not serve state or sign/acknowledge it as current.
- **RECOVERY_REQUIRED:** required evidence or durable data is missing. Operator intervention or authenticated state sync is required.

A torn final WAL frame may be discarded only if the format and crash protocol prove that it is an uncommitted suffix and the preceding committed prefix is independently verified. A malformed record in the middle of a segment, a gap, or a conflicting record is not a recoverable tail; quarantine the store. Do not silently truncate corruption.

## 8. CometBFT block-store boundary

CometBFT's block store and an application-owned filesystem WAL are separate persistence systems. A local application commit marker does not make the CometBFT block store and application state one atomic transaction.

The integration must therefore define and test both crash windows:

- CometBFT has durably stored/committed a block, but the application state generation is not yet durable.
- The application has durably recorded a transition, but the corresponding CometBFT block-store state is missing, rolled back, or cannot be independently verified.

On restart, the adapter must reconcile against authenticated CometBFT history and deterministic replay. If it cannot prove a unique consistent prefix, it must quarantine and require authenticated recovery. It must not invent a block, infer finality from an ABCI callback/ACK, or trust a higher local height merely because it exists on disk.

Before choosing a concrete integration point, inspect the exact pinned CometBFT version's ABCI++ lifecycle, application DB transaction semantics, block-store persistence order, replay behavior, and recovery guarantees. Prefer a storage transaction boundary explicitly supported by that version where possible; do not assume a filesystem rename can atomically commit two independent stores.



### ABCI 2.0 lifecycle constraint (CometBFT v0.38.26)

The pinned dependency is exactly github.com/cometbft/cometbft v0.38.26. Its ABCI 2.0 lifecycle must not be reduced to applying transaction bytes to the PoC StateMachine:

- InitChain establishes the initial application state. The first block header's AppHash is the app_hash returned by InitChain; it is not a value inferred from an arbitrary local snapshot.
- FinalizeBlock executes the decided block and returns the candidate application hash and transaction results. Application state changes from proposal/pre-execution must not become committed state merely because PrepareProposal or ProcessProposal ran.
- Commit is the application persistence boundary: the application must durably persist its state before returning from Commit. The app's Info response after restart must describe the last successfully committed height.
- CometBFT's own block store and state store are distinct from the application's storage. The block-store decision, CometBFT state persistence, and application Commit are separate ordered events with crash windows; no local WAL rename makes them one atomic transaction.
- The post-state of block H is exposed as Header(H+1).AppHash. This is why the next-height anchor verifies both the H+1 commit and the validator-set transition, while checking Header(H+1).LastBlockID == BlockID(H).

The D2 adapter must model the exact ABCI request/response and crash sequence for the pinned release, including the case where FinalizeBlock succeeded but Commit did not, and the case where CometBFT has persisted the decision but application Commit failed. The simplified transaction-only StateMachine is not a substitute for this lifecycle.

Reference specifications to pin during implementation review:
- https://github.com/cometbft/cometbft/blob/v0.38.26/spec/abci/abci++_app_requirements.md
- https://github.com/cometbft/cometbft/blob/v0.38.26/spec/core/data_structures.md
- https://github.com/cometbft/cometbft/blob/v0.38.26/spec/abci/abci++_basic_concepts.md

## 9. Locking and platform contract

The lock must provide inter-process exclusion, not merely a Go mutex. The implementation must:

- acquire the lock before reading mutable store metadata;
- hold it through recovery and all writes;
- use OS-supported lock primitives with documented process-crash release behavior;
- avoid deleting/replacing a lock file based only on PID or age;
- reject unsafe lock-file symlinks and unexpected file types;
- bound lock acquisition and return a typed timeout/busy error;
- test independent processes, simultaneous startup, process termination while holding the lock, PID reuse, and stale metadata.

POSIX and Windows implementations require separate tests. Windows rename/replace and directory-flush semantics differ from common POSIX assumptions; no cross-platform guarantee should be claimed until tested on supported filesystems.

## 10. Rollback and tamper model

A local attacker who can rewrite all local files can recompute unkeyed checksums and hash chains, and may replace both the snapshot and its manifest with an older valid generation. A key stored beside the data does not solve this.

Rollback detection requires an external authenticated monotonic reference, such as a recently verified consensus checkpoint retained outside the attacker-controlled store, a hardware-backed monotonic primitive, or another independently protected witness. This PoC must not claim rollback resistance without implementing and testing such a mechanism.

Disk encryption protects confidentiality at rest but does not, by itself, prove freshness or consensus finality. A MAC protects integrity only while its key remains outside the attacker's control.

## 11. Resource limits

Set and test hard bounds for:

- maximum WAL segment and record bytes;
- maximum snapshot bytes, entries, and operation records;
- maximum number of segments scanned and blocks replayed per recovery;
- maximum lock wait, I/O retry, and recovery duration;
- maximum temporary disk usage and retained generations;
- maximum malformed-record diagnostics (avoid log amplification).

When a bound is reached, stop with a typed error and preserve source evidence for diagnosis. Do not silently skip records or return a partially replayed state.

## 12. Required adversarial test matrix

A future implementation is not ready until tests cover at least:

1. clean close/reopen and byte-identical recovered app hash;
2. crash before WAL append, during header, during payload, and after WAL fsync;
3. crash during temporary snapshot write, after snapshot fsync, before/after rename;
4. crash during manifest publication and `CURRENT` replacement;
5. snapshot corruption, checksum mismatch, malformed lengths, duplicate/unsorted keys and IDs;
6. WAL truncation at every byte boundary of a final frame;
7. middle-segment corruption, record gap, reordered records and hash-chain mismatch;
8. duplicate committed block replay and conflicting block at the same height;
9. snapshot rollback to an older valid generation;
10. wrong project, genesis, block ID, validator set, commit signature or app hash;
11. application state ahead of, behind, or conflicting with CometBFT block-store history;
12. two independent processes racing to open/write the same project store;
13. process kill while holding the lock and during every durability phase;
14. disk full, permission denied, read-only filesystem, I/O error and failed sync;
15. resource-limit exhaustion and maliciously large/corrupt input;
16. POSIX and Windows behavior on the supported filesystems.

Tests must use subprocesses for process-level crashes and lock contention. In-process goroutines alone do not establish inter-process correctness.

## 13. Implementation gates

Implement in separate, reviewable increments:

- **D1 — format and pure codec:** versioned WAL records, strict decoder, canonical test vectors, bounded parsing.
- **D2 — block-atomic format and single-process durable store:** first implement and validate a complete-block WAL envelope as specified in §5.1; only then append, sync, publish atomic snapshot generations, reopen/replay, and expose typed errors.
- **D3 — process exclusion:** platform-specific lock implementations and subprocess tests on Linux, macOS and Windows.
- **D4 — crash/fault injection:** deterministic crash points, short writes, disk-full and sync failures.
- **D5 — CometBFT reconciliation:** pinned-version integration tests for both persistence crash windows and authenticated replay.
- **D6 — rollback defense:** separately protected checkpoint/freshness mechanism and adversarial rollback tests.

Passing D1-D4 would establish only local storage behavior. It would not prove BFT safety, authenticated bootstrap, validator independence, or production readiness. D5-D6 remain mandatory before making any stronger recovery or trust claim.

## 14. Current decision

No filesystem storage implementation is approved by this specification. D1's pure ZWL1 codec and canonical golden-vector/adversarial tests have been added in wal_codec.go and wal_codec_test.go; validation, CodeQL, cross-platform Rust lock tests, ClamAV integration, and private-runner smoke checks completed successfully on PR head b6c83192a2cbe9d07722647bae7b65be9b303c82. Review then identified that one-transaction-per-record does not establish complete-block persistence. Therefore ZWL1 remains a codec-only experiment and must not be used by D2 as a durable commit record. The next gate is to inspect the pinned CometBFT block encoding/DataHash and implement a new block-atomic WAL format with exact full-block binding. No filesystem mutation, fsync, WAL append, or runtime integration is implemented. The existing in-memory state machine and snapshot codec remain unchanged.
