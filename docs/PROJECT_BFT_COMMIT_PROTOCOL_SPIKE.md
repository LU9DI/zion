# Project BFT commit protocol — design gate

Status: **protocol not selected; no BFT implementation is claimed**  
Scope: PR #68, fully decentralized core

## 1. Purpose and boundary

Zion needs a deterministic, project-scoped committed-state layer before peer admission, revocation, authorization epochs, leases, quotas, and lifecycle transitions can become independent of PostgreSQL.

The existing `src/project-governance.js` is a deterministic governance state machine. Its threshold signatures authorize a proposed governance change; they do not establish that a distributed validator committee agreed on one ordered history. The signed event journal and replica are durable signed-record mechanisms, not consensus.

These mechanisms must remain separate:

- **Governance authorization:** who may propose or approve a project policy/membership change.
- **Validator consensus:** which state transition is committed, in what order, and with what Byzantine fault assumptions.
- **Peer transport authentication:** which cryptographic peer is connected.
- **Application authorization:** whether the authenticated peer may perform a specific operation under the latest committed project epoch.

A valid governance certificate, authenticated Noise session, signed journal record, replica ACK, or storage receipt is not by itself a BFT commit certificate.

## 2. Safety assumptions that must be explicit

**Validator-membership gate:** before choosing a committee protocol or assuming a 3f+1 / 2f+1 fault model, resolve [DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md](DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md). Distinct public keys are not evidence of independent operators; VRF selection does not create Sybil resistance. Until the membership assumptions are approved, no committee algorithm or BFT engine can be selected responsibly.

A protocol proposal must define, rather than imply:

1. Validator committee membership and the exact committed state from which it is derived.
2. The maximum Byzantine validators tolerated in each committee and how committee independence is assumed.
3. The quorum rule and proof of quorum intersection for the selected protocol.
4. How validators persist votes/locks before sending messages and prevent equivocation across restart.
5. How proposals, rounds/views, timeouts, and leader/proposer changes work.
6. How conflicting proposals and stale/forked certificates are rejected.
7. How membership/committee reconfiguration preserves safety across epochs.
8. What liveness assumptions are required (eventual synchrony, network bounds, responsive honest quorum).
9. What happens during partitions: critical mutations must stop without quorum; no central fallback or split-brain.
10. How protocol upgrades, version negotiation, and recovery from incompatible state are handled.

The familiar 3f+1 committee / 2f+1 quorum relationship is only a candidate fault model, not a complete protocol. Quorum arithmetic alone does not prevent equivocation or prove safety. The selected protocol's locking, view-change, commit, and reconfiguration rules require a reviewed safety argument.

## 3. Required commit object

The selected protocol must define a canonical, versioned commit object binding at least:

- protocol identifier and version;
- project identifier;
- committee/authorization epoch;
- height or monotonically increasing committed sequence;
- round/view and proposer identity, where applicable;
- parent committed-state digest;
- deterministic transition/block digest;
- resulting state digest;
- quorum evidence with unique validator identities and signatures;
- any required view-change/lock evidence;
- bounded canonical encoding and strict schema validation.

Every validator must independently validate the transition against the parent state and committee rules. A certificate must not be accepted merely because it contains enough syntactically valid signatures; signatures must be from the correct committee and bind to the exact project, epoch, height, round, parent, and block digest.

## 4. Anti-equivocation and durable voting

Before a validator emits a vote that could contribute to a commit, it must durably record the protocol-specific safety state required to prevent signing conflicting proposals after a crash or restart.

The implementation must specify and test:

- atomic durable write of vote/lock state;
- fsync and directory durability requirements for supported platforms;
- recovery and validation of persisted state before networking starts;
- behavior on truncated, corrupt, rolled-back, or conflicting local state;
- fail-closed handling when durable safety state cannot be proven;
- no automatic deletion or reset of safety state to make startup succeed.

A node-local signed event journal is not a substitute for the protocol's vote/lock persistence unless the protocol explicitly proves that the journal's semantics satisfy the required safety invariant.

## 5. Membership and epoch transitions

The project governance threshold and validator quorum are distinct policies. The implementation must define whether governors and validators overlap, how validator eligibility is determined, and how committee changes are authorized.

A membership change must not let old and new committees independently commit conflicting histories. The selected protocol must specify a safe reconfiguration procedure (for example, a proven joint-consensus or epoch-transition mechanism), including:

- the exact old and new committee configurations;
- which configuration authorizes each transition;
- the transition certificate required to activate the new epoch;
- rejection of old-epoch votes after activation;
- recovery when some peers have only the old or only the new configuration;
- governance-key rotation/revocation interaction with in-flight consensus rounds.

Do not infer committee membership directly from `governors` or use the governance threshold as a BFT quorum.

## 6. Candidate evaluation — no selection yet

Evaluate mature, documented Byzantine-fault-tolerant state-machine replication designs before selecting an implementation. At minimum, compare:

- a HotStuff-family protocol (including its chained/leader-rotation variants);
- Tendermint-style BFT;
- another actively maintained, independently reviewed implementation suitable for the chosen runtime, if one meets the same requirements.

For each candidate, record the exact protocol/version and implementation, maintenance status, license, runtime compatibility, cryptographic dependencies, validator reconfiguration model, safety/liveness assumptions, persistence contract, networking integration, operational complexity, known limitations, and reproducible adversarial test coverage.

Do not select a library based only on popularity, a README claim, benchmark throughput, or the fact that it exposes a quorum API. If no candidate meets the security and portability requirements, keep the design gate open rather than hand-writing a consensus protocol as a shortcut.

## 6A. Preliminary implementation candidate assessment

Assessment date: 2026-11-13. This is a source/documentation screening, not a code audit, dependency approval, independent review, or protocol selection. Upstream references are recorded so a later review can pin exact tags/commits and licenses.

### Candidate A — CometBFT (Tendermint-family)

**Positive evidence**

- The upstream repository publishes a protocol specification covering consensus, proposal construction, validator signing, light-client verification, and a write-ahead log for crash recovery.
- Its specification describes a weighted validator set, commits with more than two-thirds of current validator weight, and safety/liveness while less than one-third of validator weight is malicious or faulty.
- The upstream changelog shows active 2026 development, including v0.40.0 dated July 27, 2026 and subsequent unreleased changes at the time of this screening.

**Zion fit / blockers**

- CometBFT is a Go implementation. The inspected Zion repository's runtime is Node.js >=20; its Rust workspace currently has a small storage-core crate and does not provide a BFT engine or an existing Go integration boundary.
- Integrating it likely means a separately managed Go process or a substantial foreign-runtime boundary, plus a versioned application protocol and operational lifecycle. This is a material complexity cost, not a transparent library dependency.
- Its block/height and validator-set model is chain-oriented. Zion must prove how independent project-scoped state machines map to this model without introducing an unwanted global chain or requiring one heavyweight consensus process per project.
- The exact validator-set update, durable signing, WAL recovery, light-client trust bootstrap, and app-state determinism contracts must be reviewed against the exact version selected. A protocol spec and upstream tests do not prove Zion's integration correct.

**Disposition:** strongest current reference implementation/specification candidate for a deeper feasibility spike; not approved or selected. Must first demonstrate a minimal isolated project-scoped ABCI application, process isolation, validator reconfiguration, crash recovery, and multi-process adversarial tests without central services.

### Candidate B — libhotstuff

**Positive evidence**

- The upstream project provides a HotStuff state-machine replication prototype, modular protocol components, and a documented event-driven HotStuff variant.
- It is Apache-2.0 according to the repository's displayed license metadata.

**Zion fit / blockers**

- The repository is C++14, not Node.js or Rust, so it also requires a sidecar/FFI boundary and another runtime.
- Its own README describes the project as in progress and advises users to treat it as experimental.
- Its TODO explicitly lists persistent protocol state/recovery as unfinished, as well as pacemaker robustness and memory growth/chain pruning concerns. Durable anti-equivocation recovery is a hard Zion safety requirement, so this is a disqualifying gap for direct production adoption until independently resolved and tested.
- The codebase is a research/prototype implementation; no independent production suitability or security audit is established by this screening.

**Disposition:** reject as a direct production dependency in its currently documented state. It may remain a protocol/reference implementation for comparison, not a runtime selection.

### Candidate C — Narwhal / Bullshark (Sui)

**Positive evidence**

- The design is Rust-based and provides a DAG-oriented mempool/consensus architecture, which is closer to Zion's Rust component boundary than the Go/C++ alternatives.

**Zion fit / blockers**

- The standalone `MystenLabs/narwhal` repository is archived/read-only (archived October 17, 2022); its README directs ongoing development to the Narwhal subtree in the Sui repository.
- It is coupled to the Sui validator/runtime ecosystem and its cryptographic, storage, networking, committee, and execution assumptions. A code subtree is not automatically a supported standalone consensus library.
- Extracting or adapting it risks importing a substantial framework and protocol surface, contrary to Zion's minimal-complexity goal. The current Sui revision, supported integration API, license/dependency closure, validator reconfiguration, and crash-safe anti-equivocation semantics would all need a fresh source audit.

**Disposition:** do not adopt the archived standalone repository. Keep the actively maintained Sui subtree as a research candidate only if a small, supported, reusable integration boundary can be demonstrated without importing Sui as a mandatory platform.

### Preliminary decision

No candidate currently satisfies all Zion constraints on the evidence gathered. CometBFT is the leading feasibility candidate because it has an explicit protocol specification, WAL/recovery documentation, validator-set model, and ongoing upstream releases, but its Go/chain-oriented integration cost may violate Zion's simplicity and project-isolation goals. libhotstuff has an explicit persistence/recovery gap. Narwhal's standalone repository is archived and its successor is Sui-integrated.

**No consensus dependency has been added. No protocol has been selected.** Next gate: inspect exact tagged source and licensing, build a throwaway multi-process proof of concept outside the official launcher, and measure resource/process isolation for two independent project committees. The PoC must not alter production code or make PostgreSQL/Neon a consensus dependency. If CometBFT cannot satisfy the project-scoped/no-central-service model without excessive complexity, keep the design gate open and evaluate another maintained, audited engine rather than writing BFT from scratch.

## 7. Mandatory adversarial acceptance suite

The eventual implementation must be tested with independent OS processes and deterministic fault injection, not only in-process mocks:

- up to the declared Byzantine fault threshold, including equivocation and conflicting proposals;
- duplicate, delayed, reordered, dropped, and partitioned messages;
- leader/proposer crash before and after each durable-write/send boundary;
- validator restart with persisted locks and votes;
- stale, forged, replayed, wrong-project, wrong-epoch, wrong-parent, and wrong-committee certificates;
- concurrent governance changes and validator-set reconfiguration;
- old/new committee overlap and partial epoch adoption;
- clock skew and timeout manipulation within declared assumptions;
- resource exhaustion, oversized messages, connection churn, and malicious peers;
- loss of quorum, proving critical writes fail closed and no hosted fallback is used;
- deterministic replay from genesis to the same committed state digest on every honest node.

Tests must assert both safety (no two honest nodes commit conflicting values at the same project/height) and the precisely stated liveness property under the protocol's assumptions. A passing test suite is evidence for the tested model, not a mathematical proof or independent security certification.

## 8. Implementation order

1. [x] Complete the source-level admission/authorization inventory in `docs/ADMISSION_AUTHORIZATION_SOURCE_AUDIT.md`; its findings identify the missing deterministic operation identity/result record and the existing dispatch/revocation linearization semantics.
2. Select and review a concrete BFT protocol and exact maintained implementation.
3. [x] Draft the application transition/idempotency/recovery contract in `docs/DECENTRALIZED_TRANSITION_STATE_MACHINE_SPEC.md`; physical-storage semantics, operation-result retention, external side-effect fencing, and committee Sybil assumptions remain unresolved. Vote, certificate, and durable BFT safety-state schemas remain blocked on protocol selection.
4. Implement a storage-neutral committed-state interface with a test-only deterministic harness.
5. Integrate the selected protocol in isolated multi-process tests.
6. Connect governance certificates as authorization inputs, not as consensus certificates.
7. Migrate admission/revocation and epoch checks to committed state.
8. Replace the official launcher only after the no-PostgreSQL startup and multi-node gates pass.
9. Prove partition behavior, restart recovery, reconfiguration, and hosted-service outage behavior.
10. Remove transitional PostgreSQL requirements only after parity and recovery evidence.

## 9. Explicit non-goals for this increment

- No BFT algorithm or consensus dependency is selected or added.
- No governance threshold is re-labelled as a validator quorum.
- No central database, hosted scheduler, CA, bootstrap endpoint, or privileged peer is introduced.
- No launcher cutover, migration execution, Neon change, merge, deployment, or release is performed.
- No production-readiness or Byzantine-safety claim is made.


## 10. Validator membership and Sybil decision gate

The dedicated [validator membership and Sybil threat model](DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md) records the incompatibility between unrestricted cheap identity creation and strong identity-counted committee security, compares candidate scarcity/uniqueness mechanisms, and defines the interim boundary of project-governed validator eligibility. It is a design gate, not an implementation. The BFT protocol-selection step remains blocked until the project explicitly accepts the membership and independence assumptions. In particular, a VRF, random beacon, threshold signature, or 3f+1 committee calculation must not be represented as a Sybil defense.
