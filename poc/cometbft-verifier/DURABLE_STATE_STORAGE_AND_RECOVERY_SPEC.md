# Durable State Storage and Recovery Protocol (PoC Specification)

**Status:** design specification only; not implemented or validated.  
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

A checksum/hash chain detects accidental damage and some local edits; it does **not** authenticate a writer or prevent an attacker from rewriting the entire chain. Authentication comes from independently verified consensus evidence, not from the local WAL hash chain.

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
- **D2 — single-process durable store:** append, sync, atomic snapshot generation, reopen/replay, typed errors.
- **D3 — process exclusion:** platform-specific lock implementations and subprocess tests on Linux, macOS and Windows.
- **D4 — crash/fault injection:** deterministic crash points, short writes, disk-full and sync failures.
- **D5 — CometBFT reconciliation:** pinned-version integration tests for both persistence crash windows and authenticated replay.
- **D6 — rollback defense:** separately protected checkpoint/freshness mechanism and adversarial rollback tests.

Passing D1-D4 would establish only local storage behavior. It would not prove BFT safety, authenticated bootstrap, validator independence, or production readiness. D5-D6 remain mandatory before making any stronger recovery or trust claim.

## 14. Current decision

No storage implementation is approved by this specification. The next safe code increment is D1 (pure WAL record codec and test vectors), followed by review of its exact wire format before filesystem mutation is introduced. The existing in-memory state machine and snapshot codec remain unchanged until that format is independently reviewed.
