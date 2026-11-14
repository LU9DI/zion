# Decentralized transition state machine — specification gate

Status: **proposed deterministic domain specification; not implemented and not a consensus protocol**  
Scope: project-scoped admission, revocation, release, capacity, invitation replay, and operation reconciliation.

## 1. Boundary

This document refines the storage-neutral requirements in `DECENTRALIZED_ADMISSION_AUTHORIZATION_CONTRACT.md` and the source findings in `ADMISSION_AUTHORIZATION_SOURCE_AUDIT.md`.

It specifies what a deterministic application state machine must decide after an ordered command is proposed. It does not choose a BFT engine, define its wire protocol, or make local observations authoritative. No production adapter or launcher integration is included.

The state machine is deterministic only if every input affecting acceptance is part of the committed state or the canonical command. Wall-clock time, local disk free space, local caches, DHT records, transport connection state, and uncommitted gossip must not silently affect transition validity.

## 2. Canonical command envelope

Every state-changing command must have a strict, versioned envelope with exactly these conceptual fields:

- `schemaVersion`: fixed supported integer;
- `projectId`: canonical project identifier;
- `operationId`: 32-byte client-generated random identifier, encoded as lowercase hex;
- `operationType`: one of the closed operation enum values;
- `expectedEpoch`: project authorization/governance epoch expected by the caller;
- `expectedStateDigest`: digest of the exact committed parent state;
- `payload`: operation-specific closed schema.

The operation digest is computed over a domain-separated canonical encoding of the entire envelope excluding the digest field itself. The commit record binds project ID, operation ID, operation digest, parent digest, resulting state digest, protocol epoch, and the deterministic result code/data.

Canonical encoding requirements:

- UTF-8 with one specified canonical encoding algorithm and version; do not rely on ordinary object insertion order or unspecified serializer behavior.
- Exact field sets; reject unknown fields, duplicate semantic entries, invalid encodings, oversized strings/arrays, and unsafe numeric values.
- Use integer units for quotas, capacity, counters, and sequence numbers. No floating-point values in consensus state.
- Normalize identifiers under a documented rule before hashing; never normalize opaque public keys or signatures.
- Domain-separate hashes by protocol, schema version, project, and purpose.
- Publish cross-language test vectors before any Node/Rust/Go implementation is considered interoperable.

No canonical encoding library is selected by this specification. JSON.stringify of arbitrary JavaScript objects is not an approved wire format.

## 3. Operation identity and retry rules

The committed state must contain a durable operation-result index keyed by `(projectId, operationId)`, or a cryptographically verifiable equivalent that can answer the same query after restart.

For each proposed command:

1. Validate the envelope and compute its canonical operation digest.
2. Look up the operation ID in committed history before applying the transition.
3. If the ID exists with the same digest, return the exact original committed result and commit reference; do not execute the transition again.
4. If the ID exists with a different digest, reject as operation-ID conflict and emit an auditable security event.
5. If the ID is absent, validate expected parent/epoch and operation-specific invariants, then deterministically compute the next state and result.
6. Persist the operation record atomically with the state transition as part of the same committed application.
7. If the proposer loses the response, it must query the same operation ID. It must not generate a new ID merely because the result is unknown.

An operation ID is not a nonce for invitation consumption. Invitation nonces remain separately unique, issuer-bound, and permanently replay-protected for as long as the project history can be replayed. Compaction must preserve equivalent authenticated replay-protection state.

A local timeout means **unknown**, not failed. A quorum commit certificate proves ordering/commit under the selected protocol; each node still needs durable application recovery so a crash between consensus commit and local apply can replay the committed command exactly once.

## 4. Deterministic state model

The minimum logical project state includes:

- project ID, schema/protocol version, committed height, parent/state digest;
- governance epoch and governance policy state;
- validator committee epoch and weighted membership, distinct from governors;
- peer admission records with terminal status and monotonically increasing admission version;
- revocation tombstones, including never-admitted identities;
- consumed invitation nonce records bound to issuer and subject;
- issuer quota counters or deterministic derivation from committed history;
- logical capacity policy, active reservations, and reservation provenance;
- operation-result records or an authenticated index with equivalent query guarantees.

All collections require canonical ordering for hashing. State transitions must reject overflow, duplicate map keys, invalid terminal-state changes, and unknown enum values.

## 5. Transition rules

### 5.1 ADMIT

Inputs bind subject, distinct authorized issuers, invitation evidence/nonces, policy version, and requested logical reservation units.

Reject if the subject is active, revoked, or otherwise terminal under policy; any nonce was consumed; any issuer is not authorized in the expected epoch; issuer quotas would be exceeded; or the logical capacity limit would be exceeded.

On acceptance, atomically create the active admission, increment its version, consume all invitation nonces, update issuer quota accounting, reserve logical capacity, and store the operation result.

A failed transition must also have a deterministic result. Whether rejected commands are committed into the operation index must be a protocol-level policy; to make retry results stable across policy changes, the preferred design is to commit a bounded rejection result only when the command has passed envelope/parent validation and entered the ordered state machine. Malformed or stale-parent commands may be rejected before ordering and need not consume an operation ID.

### 5.2 REVOKE

Revocation creates or updates a durable tombstone even if no admission record exists. If active, it decrements the logical reservation exactly once and advances the admission version. If already revoked, the same semantic request returns an idempotent terminal result. A released peer cannot be silently converted to revoked by a stale command; a separately authorized transition would be required.

### 5.3 RELEASE

Only an active admission may release a reservation. It decrements logical capacity exactly once and advances the admission version. Repeating a release returns the original terminal result. A revoked admission cannot become released through a stale command.

### 5.4 AUTHORIZE

Authorization is a deterministic read against a locally verified committed state and an operation's required project epoch/admission version. It fails closed if the node cannot establish that it has the required committed state or if the peer is absent, released, revoked, or stale.

This check alone cannot guarantee that a later external side effect is still authorized. Side effects must either be delayed until a protocol-defined commit point or be idempotently fenced by a committed operation. A long-running callback must not hold a distributed lock. The application must document whether authorization is required at dispatch, at side-effect commit, or both.

## 6. Capacity is not physical truth

A consensus engine can agree on a logical quota or reservation; it cannot make remote free-disk measurements globally true.

Therefore:
- Consensus state may enforce deterministic logical slot/byte quotas and reservation accounting.
- Local disk free-space readings are advisory safety checks for the local node, not a globally comparable consensus input.
- A node must refuse local storage work when its own hard resource limits are reached, even if the project has logical capacity remaining.
- If the product requirement is a global guarantee that a specific amount of physical storage is available across peers, the design needs explicit storage-provider commitments, collateral/penalty or challenge mechanisms, and failure semantics. That is a separate protocol and is not solved by counting peer-reported free bytes.
- No single peer's capacity receipt may authorize an overbooking of the committed logical limit.

This distinction is a blocking product decision before translating the current PostgreSQL headroom ratio into distributed semantics.

## 7. Determinism and recovery invariants

For every valid committed parent state and canonical command, all honest application replicas must compute byte-identical result data and the same resulting state digest.

The application layer must:
- apply committed entries in strictly increasing sequence/height;
- atomically persist applied height, state, and operation-result index, or recover them from a durable committed log;
- tolerate crash after consensus commit but before application, and replay without double-reserving capacity or consuming invitation nonces twice;
- detect local state rollback/divergence against the commit chain and fail closed;
- never reset vote/lock safety state as an application recovery shortcut;
- distinguish consensus commit from local application completion;
- expose a query for operation status: unknown, ordered/pending, committed-not-applied, applied, or deterministically rejected.

These are application-level requirements; validator vote/lock persistence remains the selected BFT engine's separate responsibility.

## 8. Minimum property and fault tests

Before integration, a test-only pure state machine must have property tests for:

- same operation ID + same digest is idempotent;
- same operation ID + different digest is rejected;
- distinct operation IDs cannot consume one invitation nonce twice;
- concurrent ordered admissions never exceed logical capacity or issuer quotas;
- revocation of never-admitted identities persists as a tombstone;
- release/revoke decrement reservations at most once;
- terminal-state transitions cannot be reversed by stale commands;
- every permutation of map insertion order yields the same canonical digest;
- unsafe integers, fractional values, negative quantities, overflow, unknown fields, and oversized inputs fail closed;
- crash/replay at every commit/apply/result-persistence boundary yields the same state digest and operation result;
- Node and Rust implementations pass identical published canonicalization/state-transition vectors.

Then multi-process tests must inject partitions, delayed/reordered messages, lost responses, crashes, disk-full, corrupt/rolled-back state, and quorum loss. These tests do not replace a protocol safety proof or independent review.

## 9. Unresolved decisions — no silent assumptions

1. **Operation result retention:** how long are operation IDs and results queryable, and what authenticated compaction proof preserves replay safety?
2. **Physical storage promise:** is capacity a logical quota, a per-node local cap, or a verifiable distributed storage commitment? These are different guarantees.
3. **Admission policy changes:** are rejected commands ordered and recorded, or only successful transitions? The choice affects retry stability and denial-of-service surface.
4. **External side effects:** which operations can be delayed until a commit, and which require idempotency keys at external resource boundaries?
5. **Committee scope:** what minimum validator population/independence assumptions make a project-scoped committee resistant to Sybil capture without a central identity authority? This is tracked as a blocking design gate in [DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md](DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md); do not infer independence from distinct keys or VRF selection.

Until these decisions and the BFT protocol gate are resolved, do not implement a consensus adapter or remove PostgreSQL from official startup.

## 10. Explicit non-claims

- No BFT protocol, validator quorum, wire encoding, or consensus engine is selected.
- No code or dependency is added by this specification.
- No global physical storage guarantee is claimed.
- No Byzantine safety, liveness, Sybil resistance, or production readiness is proven.
- PostgreSQL, Neon, migrations, and the official launcher remain unchanged.
- No merge, deployment, release, or migration is authorized.
