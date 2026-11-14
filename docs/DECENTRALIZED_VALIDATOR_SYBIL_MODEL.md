# Decentralized validator membership and Sybil threat model

Status: **architecture decision gate; no Sybil-resistant committee algorithm is selected or implemented**  
Scope: PR #68, project-scoped validator membership and committee reconfiguration.

## 1. Decision summary

Zion's existing constraints prohibit a mandatory global chain, native token, mining, central identity provider, hosted coordinator, and privileged super-node. Those constraints are retained.

However, cryptographic node identities do not establish independent operators. An attacker can generate many Ed25519 key pairs. A VRF can make selection unpredictable and publicly verifiable, but it cannot make a set of attacker-controlled keys independent. A BFT quorum is safe only relative to its validator membership and Byzantine-fault assumptions.

Therefore the following distinction is mandatory:

- **Open peer participation:** anyone may run a node, discover peers, store ciphertext, and exchange bounded protocol messages subject to local resource policy.
- **Project validator eligibility:** the right to vote on project-critical committed state. This is a separate, explicitly governed membership decision.
- **Sybil resistance:** a property of the eligibility/admission model and its scarce-resource or identity assumptions, not a property supplied by Ed25519, VRF, random selection, or BFT alone.

The current architecture has no approved universal scarce resource or personhood root. Consequently, it cannot yet claim strong, permissionless Sybil resistance. No validator-selection algorithm should be implemented or described as solving that gap until the project chooses and documents an acceptable trust assumption.

## 2. Why the gap is fundamental

If identities can be created at negligible cost and the protocol has no way to distinguish independent operators, unique persons, or scarce resources, an adversary can create enough identities to dominate an identity-counted election. One-key-one-vote, majority signatures, reputation initialized by self-assertion, and random selection over all discovered keys do not change that fact.

The impossibility statement is conditional and deliberately narrow: it applies to a fully open membership model with no scarce resource, no trusted uniqueness root, and no external constraint on adversarial identities. It does not imply that every decentralized system needs a blockchain or token. It means that a system must relax at least one of those assumptions or accept that validator capture cannot be prevented by protocol cryptography alone.

A systematic review of permissionless consensus mechanisms finds that strong Sybil resistance is concentrated in resource-based paradigms such as proof of work and proof of stake; many reputation or physical-world-linking approaches offer weaker protection or rely on additional assumptions. The published Sybil-vulnerability-trilemma result formalizes a related incompatibility among permissionlessness, Sybil resistance, and negligible participation cost within its model. These results are evidence about the trade-off, not a universal theorem covering every possible identity or social protocol.

## 3. Mechanism comparison — no option silently selected

| Mechanism | What it can provide | Critical assumption / failure mode | Fit under current Zion constraints |
|---|---|---|---|
| One public key = one vote | Simple cryptographic accountability | Keys are cheap; attacker multiplies identities | **Reject as Sybil defense** |
| VRF / cryptographic sortition | Unpredictable, privately testable selection from an eligible set | Eligibility weights and randomness source must already be trustworthy; VRF does not prove operator independence | Useful only after eligibility policy |
| Proof of work | Costly, continuously measurable computational influence | Energy/hardware expenditure, incentive/economic model, attack budget | Prohibited by current no-mining constraint |
| Proof of stake | Voting weight tied to locked scarce capital | Token/stake concentration, long-range/recovery and reconfiguration assumptions, economic governance | No native token/stake policy approved; do not introduce implicitly |
| Proof of personhood / uniqueness | Can approximate one-human-one-membership | Ceremony, biometric/social verification, collusion, coercion, resale, privacy, geographic access, governance of issuers | No trusted global personhood root exists; research only |
| Social graph / vouching / reputation | Can raise cost of creating trusted identities in a bounded community | Sybil regions, collusion, bootstrap trust, reputation transfer and newcomer exclusion; endorsers may be compromised | Possible project-local signal, not a strong standalone guarantee |
| Storage/bandwidth/resource proofs | Evidence that a node controls or serves a bounded resource | One operator can control many resources/keys; proofs establish resource possession, not unique operator or independent failure domain | Useful for storage accounting and abuse budgets, not committee identity |
| Hardware attestation / TEE | Evidence about a measured device/software state | Manufacturer roots, supply-chain trust, device cloning/relay, vendor dependence | Cannot be mandatory under no central/vendor trust requirement |
| Threshold-approved project membership | Prevents arbitrary discovered keys from immediately voting; distributes admission authority among project governors | Genesis/governor capture, collusion, compromised keys, governance concentration; not permissionless validator admission | **Closest current fit**, but explicitly permissioned at project level and not a Sybil-proof claim |
| Hybrid | Combines independent signals and limits correlated failure | Security depends on every underlying assumption and their independence; complexity can hide rather than remove trust | Consider only after requirements and adversarial model are chosen |

## 4. Current safe boundary: governed project validators

Until a stronger Sybil model is approved, the only defensible interim model is:

1. Keep peer and storage participation open where local resource limits and project authorization allow it.
2. Do not let DHT discovery, peer advertisements, connection count, signed event replication, or storage receipts grant validator voting rights.
3. Make validator eligibility a project-scoped governance transition. The existing governance threshold is an authorization primitive only; its result must later be committed by the selected BFT protocol.
4. Record validator-set changes in the committed project state, with an explicit committee epoch and a deterministic transition.
5. Require the BFT implementation to enforce its own fault threshold against that exact committee epoch. Do not infer independent operators from distinct public keys.
6. Keep project governors and BFT validators as distinct roles. A governor authorizes policy; a validator votes on ordered state transitions. Any overlap is an explicit project policy, not an implicit equivalence.
7. If genesis governance keys are compromised or colluding, the system cannot cryptographically recover the original trust assumption. Recovery must be an explicit project-level ceremony or threshold process; no Zion master key or hosted recovery authority may be introduced.
8. State the guarantee accurately: **governance-controlled validator eligibility**, not permissionless Sybil resistance.

This model can be decentralized among project participants without a central Zion operator, but it is not equivalent to unrestricted permissionless validator admission. The genesis trust ceremony and its initial independent operators remain a project-specific trust assumption.

## 5. Committee selection, randomness, and rotation

These are separate protocol layers and must be designed in this order:

1. **Eligibility:** determine which validator identities are eligible and under which committed epoch/policy.
2. **Influence:** define whether each eligible identity has equal or weighted influence, and justify the weight source. Equal weight is unsafe if one operator can cheaply create multiple eligible identities.
3. **Randomness:** only then select a committee or proposer. The random beacon must be unpredictable before the relevant commitment, publicly verifiable, bias-resistant under its stated adversary model, and recoverable across restart. A previous-block hash or proposer-controlled seed is not automatically an unbiased beacon.
4. **Fault model:** specify the maximum Byzantine fraction by eligible voting weight and the operational independence assumption. For a 3f+1 committee and 2f+1 quorum, the usual arithmetic does not prove that f+1 keys are not controlled by one operator.
5. **Rotation:** bind the next committee to the current committed state, next committee epoch, selection seed/beacon, eligibility snapshot, and protocol version. Define overlap and handoff rules so old and new committees cannot commit conflicting histories.
6. **Recovery:** define how lost, compromised, offline, or newly discovered validators are handled without unilateral override or central fallback.

A VRF may prove that a particular key correctly evaluated a selection function. It does not prove that the key belongs to a unique person, organization, machine, or independent operator. A randomness beacon may prevent predictable selection; it does not prevent a Sybil from controlling most eligible keys.

## 6. Required adversarial tests before selection can be called secure

The future design and implementation must include, at minimum:

- One adversarial operator generating thousands of node keys and peer advertisements.
- Multiple identities controlled by the same process, host, organization, or storage provider.
- Colluding governors admitting attacker-controlled validators.
- Compromise of a threshold of genesis/governance keys.
- Sybil identities spread across DHT regions and peer-exchange paths to simulate eclipse pressure.
- VRF key grinding, seed manipulation, proposer withholding, beacon bias, and selective aborts.
- Validator churn, offline nodes, partitions, stale membership snapshots, and concurrent committee rotation.
- Old/new committee overlap attacks, conflicting epoch certificates, replayed selection proofs, and restart after a vote.
- Unequal network reachability and resource budgets that make nominally distinct validators operationally correlated.
- Demonstration that losing quorum halts critical writes and cannot trigger a central or local-leader bypass.

Tests must report the actual adversarial control unit (keys, hosts, operators, organizations, or resource share). A test that creates many keys but assumes each key is an independent validator does not test operator-level Sybil capture.

## 7. Decisions still required

No default is silently chosen for these questions:

1. Is validator membership intentionally project-permissioned through the existing threshold-governance process, or must validators be admitted permissionlessly?
2. What trust ceremony establishes the initial project governors and how are their independent control domains assessed?
3. Is Zion willing to rely on any scarce resource or identity substrate? Current architecture prohibits token/mining and central identity services; any exception requires an explicit product decision.
4. If no acceptable external scarcity/uniqueness substrate exists, does Zion accept governed project membership and explicitly decline the claim of permissionless Sybil resistance?
5. What independence evidence is meaningful without collecting invasive personal data or introducing a central verifier?
6. What random-beacon construction is compatible with the chosen BFT engine and its fault/liveness assumptions?

Until these are answered, the validator committee algorithm and BFT engine selection remain blocked. Do not write a custom BFT protocol or use VRF as a substitute for Sybil resistance.

## 8. Sources and scope of claims

- Platt and McBurney, *Sybil in the Haystack: A Comprehensive Review of Blockchain Consensus Mechanisms in Search of Strong Sybil Attack Resistance*, Algorithms 16(1), 34 (2023), DOI 10.3390/algorithms16010034. A systematic review of mechanisms and their assumptions.
- Platt, Platt, and McBurney, *Sybil Attack Vulnerability Trilemma*, International Journal of Parallel, Emergent and Distributed Systems 39(4), 446–460 (2024), DOI 10.1080/17445760.2024.2352740. Its incompatibility result is model-scoped and should not be overstated as covering all possible decentralized identity systems.
- NIST IR 8460, *State Machine Replication and Consensus with Byzantine Adversaries* (initial public draft). Describes the additional challenges of permissionless participation and the need for a Sybil-resistance mechanism in the relevant model.
- De Filippi et al., *Who Watches the Watchmen? A Review of Subjective Approaches for Sybil-Resistance in Proof of Personhood Protocols*, Frontiers in Blockchain (2020), DOI 10.3389/fbloc.2020.590171. Reviews personhood approaches and their subjective trust and governance surfaces.

## 9. Explicit non-claims

- No validator eligibility algorithm, VRF scheme, random beacon, proof-of-personhood system, stake, token, mining, or resource proof is selected.
- No Sybil resistance, operator independence, committee safety, or BFT liveness is implemented or proven by this document.
- Threshold governance does not become BFT consensus by being called a quorum.
- Peer discovery, signatures, storage receipts, reputation, and local event replication do not confer validator status.
- No code dependency, runtime path, launcher, database, migration, or deployment is changed by this specification.
- PostgreSQL/Neon remain transitional and untouched; PR #63/#64 and their bases remain untouched.
