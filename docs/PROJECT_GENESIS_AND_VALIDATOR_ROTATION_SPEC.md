# Project genesis, governance bootstrap, and validator rotation

Status: **security design gate; no genesis ceremony, DKG, committee handoff, or recovery protocol is implemented**  
Scope: PR #68, project-scoped trust establishment and validator lifecycle.

## 1. Purpose and non-goals

This specification defines the security questions and minimum evidence required to establish a project's initial governance keys and change its validator committee without silently introducing a central Zion authority.

It does not select a BFT engine, DKG construction, threshold-signature suite, random beacon, proof-of-personhood system, or validator-selection algorithm. It does not claim a ceremony proves real-world independence. It does not authorize a founder, repository owner, hosted service, or single key to override committed project state.

The existing project governance code is a local deterministic authorization primitive, not a distributed genesis protocol or BFT commit protocol. The current encrypted node-identity record also lacks a production keystore/filesystem lifecycle. No runtime changes are authorized by this document.

## 2. Separate the security roles

These roles must be represented independently in project state and protocol messages:

1. **Node identity:** a long-lived Ed25519 key identifying one cryptographic node. It proves control of a key, not a unique person, organization, machine, or operator.
2. **Genesis governors:** initial project-scoped authorities that authorize the first governance policy and validator eligibility policy. Their legitimacy comes from an explicit bootstrap ceremony and its stated trust assumptions.
3. **Project governors:** participants authorized to approve policy changes under the current governance epoch. They do not automatically vote in BFT.
4. **BFT validators:** the exact committee that orders and commits project state under a selected consensus protocol and fault model. A governor is not automatically a validator.
5. **Operators / control domains:** people or organizations able to control one or more keys or nodes. This is an independence attribute, not something proven by distinct public keys.
6. **Transport peers:** authenticated network connections. Discovery, connection, replication, and ACK status do not grant governance or validator rights.

The protocol must not collapse these roles into one trusted-peer list or infer role membership from DHT discovery.

## 3. Genesis trust ceremony — required properties

A project genesis ceremony is a human-governed trust bootstrap, not a cryptographic proof that participants are honest or independent. It must make trust assumptions visible and reproducible.

### 3.1 Candidate and control-domain disclosure

Before genesis, each proposed governor/validator candidate must publish:

- project-scoped node public key and derived node ID;
- requested role (governor, validator, or both);
- proof of possession of the private key, bound to project ID, fresh genesis nonce, requested role, and exact genesis manifest digest;
- a self-declared operator/control-domain statement sufficient to assess concentration (for example, whether candidates share an operator, organization, administrator, host, cloud account, or network control plane);
- supported protocol versions and resource/availability commitments relevant to the role;
- disclosure of known conflicts or common control.

The protocol must not require legal identity, biometrics, home address, or invasive personal data by default. If a project chooses external personhood or organizational attestation, that is an explicit additional trust dependency and must be separately assessed.

Self-declaration is evidence for governance review, not cryptographic proof. A dishonest candidate can lie. The project must not claim operator independence solely because declarations differ.

### 3.2 Independent verification

The ceremony must let participants verify that public keys they approve are controlled by the intended participants. Acceptable evidence may include independently authenticated out-of-band fingerprint comparison or a project-selected multi-party verification procedure. A single website, DNS record, repository maintainer, email account, or hosted coordinator must not be the sole source of key authenticity.

The exact human verification process is project-specific and must be recorded in the genesis manifest. This specification does not prescribe an in-person meeting, government identity check, social network, or centralized registrar as mandatory.

### 3.3 Genesis manifest

The canonical genesis manifest must bind at least:

- schema and canonical encoding versions;
- project ID and fresh unpredictable genesis nonce;
- genesis context and explicit protocol/application versions;
- initial governance policy, governor public keys, and threshold rule;
- initial validator eligibility policy and exact validator public keys/weights, if validators are initialized at genesis;
- declared control-domain relationships and known concentration limitations, or an explicit statement that independence was not verified;
- initial state digest and initial governance/committee epochs;
- supported cryptographic suites and key identifiers;
- recovery policy and conditions under which recovery is unavailable;
- human-readable statement of accepted trust assumptions and known exclusions.

Every signature must cover the exact canonical manifest digest and a domain separator. Reject duplicate keys, duplicate semantic entries, unknown critical fields, ambiguous encodings, invalid thresholds, and unsupported algorithm identifiers. The same manifest must produce the same digest across supported implementations; test vectors are required before implementation.

### 3.4 Genesis acceptance

Genesis acceptance requires the policy's declared threshold of valid, distinct governor signatures over the same manifest digest, plus required proof-of-possession checks. The threshold is a project decision and must not be invented by implementation defaults.

The initial manifest and signatures must be independently retained by participants. The first committed project state must bind the manifest digest. No one participant may later rewrite the manifest or claim a different genesis without an explicit recovery/re-genesis process accepted by project policy.

A signature threshold proves that enough listed keys signed. It does not prove those keys belong to independent operators or that signers were not coerced or colluding. This limitation must be visible in the project's security posture.

### 3.5 No founder override

There is no hidden founder key, maintainer override, master password, emergency hosted API, or unilateral repository-owner authority in the protocol. Repository administration and project governance are different trust domains. GitHub ownership does not imply authority to rewrite committed project state.

If the initial governor threshold is lost or captured, ordinary governance cannot be assumed to recover safely. Recovery must follow the precommitted recovery policy and its independent trust assumptions. If that policy cannot establish authenticity, security-critical state changes must halt rather than accept an undocumented central override.

## 4. Distributed key generation: what it solves and what it does not

If a selected BFT engine requires a threshold committee key, a reviewed Distributed Key Generation (DKG) protocol may generate shares without one trusted dealer. Each participant must verify the protocol transcript and its own share; the resulting public key and DKG transcript digest must be bound to the committed committee epoch.

DKG does **not** select honest or independent participants, prove one key per operator, prevent one operator from joining with multiple admitted keys, replace BFT ordering or committee membership governance, make an unsafe initial committee safe, or guarantee liveness when required participants are unavailable.

A DKG must specify synchrony/network assumptions, corruption threshold, abort behavior, complaint/identifiable-abort rules, transcript agreement, verification, restart behavior, and resource bounds. It must be an established construction compatible with the selected consensus/threshold-signature implementation, not a new ad-hoc protocol.

The node's long-lived Ed25519 transport identity must remain distinct from any committee threshold signing key. Compromise, rotation, or resharing of a committee key must not silently replace node identity or transport trust binding.

## 5. Validator admission and rotation lifecycle

The following is a required state-transition outline, not a consensus protocol. Every transition must eventually be ordered and committed by the selected BFT engine under its documented reconfiguration rules.

### 5.1 Proposal

A rotation proposal must bind project ID and current committed state digest; current governance and validator committee epochs; exact old and proposed new committee membership/weights; candidate proof-of-possession and eligibility evidence; disclosed control-domain overlap and unverified independence assumptions; proposed effective epoch and protocol version; reason (routine rotation, planned expansion, removal, suspected compromise, or recovery); required new-committee acceptance and key-setup procedure; and deterministic handoff/failure behavior.

No local clock, DHT view, peer count, or uncommitted gossip may determine proposal validity.

### 5.2 New committee preparation

Before activation, every new validator must prove possession of its node key and validate the exact proposed committee manifest. If a committee threshold key is required, the new committee must complete the selected DKG or resharing protocol and publish a verifiable transcript/result digest.

New validators must independently obtain and verify the committed project state they are expected to continue. A snapshot supplied by one outgoing validator is not sufficient evidence by itself; it must be authenticated against prior committed history/checkpoint under the selected protocol.

### 5.3 Safe handoff

Old and new committees must not independently commit conflicting histories during transition. The selected BFT protocol must specify the exact reconfiguration boundary, quorum certificates, epoch fencing, and whether handoff is joint-consensus, a certified checkpoint transition, or another protocol-proven mechanism.

Do not improvise a rule such as "old quorum approves and new quorum starts" without proving the selected engine's safety under partitions, delayed messages, Byzantine signers, and overlapping members. The state machine must reject stale-epoch votes and commands after the transition boundary.

If the new committee cannot reach its required threshold, activation must not happen. The old committee may continue only if the selected protocol's reconfiguration rules explicitly permit it; otherwise critical writes halt. There is no automatic local-leader or hosted-service bypass.

### 5.4 Revocation and suspected compromise

Node-key revocation and validator-committee change are distinct state transitions. Revoking a transport identity must prevent it from authenticating new authorized sessions after revocation is committed and observed under protocol freshness rules. Removing its validator vote requires the consensus engine's safe committee-reconfiguration procedure.

If suspected compromise still leaves a safe quorum, the project may use a precommitted emergency proposal path with bounded scope and auditable evidence. If the attacker may control the threshold needed to commit that path, the system cannot assume an in-protocol vote is authentic. It must halt and invoke the separately precommitted recovery ceremony; if that ceremony cannot establish a trustworthy state, re-genesis may be necessary.

No emergency path may lower the threshold, change the committee, or erase evidence solely at the request of one local node.

## 6. Threshold-share rotation and mobile compromise

If a threshold secret is shared among validators, membership change must use a reviewed resharing protocol compatible with the cryptographic scheme. Simply copying old shares to new validators is not an acceptable migration design.

The lifecycle must define whether the public threshold key remains stable or is replaced; exact old/new thresholds and committee epochs; how old members contribute without learning the reconstructed master secret; verifiable correctness of each new share and resulting public verification state; how removed members' old shares become unusable for future protocol epochs; secure-erasure expectations and what implementation can actually guarantee; abort/retry behavior, partial participation, crashes, and recovery from incomplete resharing; and protection against an adversary accumulating shares across epochs.

Proactive refresh can reduce exposure to a mobile adversary only under formal assumptions: the adversary must not obtain enough valid shares within any one refresh epoch, and obsolete shares must not remain usable in combination with new shares. Refresh does not repair a committee already threshold-compromised, and software cannot prove physical erasure of every copy on a compromised host.

A committee change must use a protocol designed for resharing across different memberships/thresholds; do not assume ordinary same-committee share refresh supports membership change.

## 7. Recovery policy and failure modes

Before genesis, the project must explicitly choose and commit a recovery policy. It must cover loss of one governor key; loss beyond ordinary governance threshold; compromise of governor keys; suspected collusion/common control; loss or compromise of validator threshold shares; unavailable or partitioned old committee; inability to complete new-committee DKG/resharing; conflicting genesis manifests or competing recovery claims; lost local identity/keystore and identity continuity; and software or cryptographic-suite deprecation.

Recovery must be bounded, deterministic where it changes project state, and verifiable by independent participants. It must not rely on a permanent Zion-operated registry, cloud escrow, hosted CA, central database, or single recovery key.

If no precommitted recovery path can distinguish the legitimate project from an attacker controlling the required threshold, critical writes must stop. A fresh project identity may be created only as an explicit re-genesis, with a new project identifier and publicly documented continuity break; it must not silently overwrite old history.

## 8. Required adversarial and interoperability tests

No implementation can be approved without tests covering:

1. Conflicting genesis manifests; verify no ambiguous digest or silent replacement.
2. Duplicate keys, malformed encodings, duplicate roles, invalid thresholds, replayed genesis nonce, and proof-of-possession bound to the wrong project/manifest.
3. Founder/repository maintainer attempting unilateral override; verify no privileged protocol path.
4. Multiple keys controlled by one operator; verify concentration assumptions are recorded and keys are not treated as proven independent operators.
5. Colluding governors, threshold compromise, partial governor-key loss, and unauthorized recovery attempts.
6. DKG participants that equivocate, send invalid shares, abort, restart, or withhold messages; verify honest participants agree on one transcript/result or abort safely.
7. Validator rotation under partitions, delayed/replayed old-epoch votes, Byzantine old/new members, partial new committee availability, and conflicting handoff attempts.
8. Old/new threshold-share accumulation across epochs, repeated refresh, committee size changes, removed-member collusion, and crash during resharing.
9. Snapshot from a malicious outgoing validator; verify new validators require independently verifiable committed history.
10. Cross-implementation canonical manifest digest and protocol transcript vectors.
11. Full recovery after process restart without PostgreSQL, hosted coordinator, or central authority.
12. Loss of quorum halts critical writes and never falls back to uncommitted local state.

Tests must model operator/control-domain compromise separately from key compromise. A simulation treating every key as an independent machine is insufficient for Sybil and correlated-failure claims.

## 9. Implementation gates

Implementation must not begin until all are satisfied:

- project explicitly accepts genesis trust assumptions and recovery policy;
- genesis governor selection and independence limitations are documented;
- validator eligibility policy is resolved under DECENTRALIZED_VALIDATOR_SYBIL_MODEL.md;
- a maintained, reviewed BFT engine is selected with documented reconfiguration model;
- DKG/resharing construction and threshold-signature suite are selected from compatible, reviewed implementations;
- canonical manifest encoding and cross-runtime test vectors are specified;
- project state machine and BFT commit boundary are defined together;
- platform identity persistence/keystore lifecycle is independently implemented and tested;
- adversarial multi-process, partition, crash/restart, and key-compromise tests pass;
- independent security review covers the complete lifecycle, not only cryptographic primitives.

No implementation gate may be waived by documentation wording or a successful unit test of an isolated primitive.

## 10. Research basis and limits

- Das et al., *Practical Asynchronous High-threshold Distributed Key Generation and Distributed Polynomial Sampling*, USENIX Security 2023. Demonstrates an asynchronous DKG construction for a defined n=3t+1 model and its use in threshold cryptography; it does not solve validator eligibility or operator independence.
- Torus key infrastructure documentation describes DKG and proactive secret sharing across epochs, and warns against simply copying shares between epochs. It is an implementation reference, not independent proof that the same design fits Zion.
- Siddarth et al., *Who Watches the Watchmen?*, Frontiers in Blockchain (2020), reviews proof-of-personhood and subjective identity approaches, including trust, privacy, and governance surfaces. It does not establish a universal trust-free uniqueness solution.

## 11. Explicit non-claims

- No genesis ceremony has been conducted and no real-world participant independence has been verified.
- No governor set, validator set, threshold, DKG, resharing, recovery authority, or consensus protocol is selected by this document.
- No BFT safety/liveness, Sybil resistance, secure erasure, or key recovery is implemented or proven.
- The project governance primitive, Ed25519 node identities, local journal, and replica do not implement this lifecycle.
- No runtime, launcher, database, migration, dependency, or deployment is changed by this specification.
- PostgreSQL/Neon remain transitional and untouched; PR #63/#64 and their bases remain untouched.
