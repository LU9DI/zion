# Zion-wide founding cohort: consensus options and safety analysis

**Status:** architecture analysis; no product-policy change approved  
**Scope:** PR #68, branch `architecture/fully-decentralized-core`  
**Date:** 2026-11-15  
**Purpose:** resolve the technical part of the global founding-ordinal blocker without silently choosing a product policy.

## 1. Requirement being evaluated

The current invitation ADR requires all of the following:

- one Zion-wide founding cohort of exactly the first 1,000 successfully admitted user identities;
- a unique, contiguous ordinal sequence from 1 through 1,000;
- one-time invitation consumption and recipient admission;
- no single database, website counter, DHT record, cache, or GitHub workflow as authority;
- fail-closed admission when the network cannot establish a canonical committed result;
- project-scoped validator committees and no global blockchain/global validator committee in the current BFT direction.

The first four founder properties are not equivalent to merely limiting the number of founder badges. They require a canonical ordering of successful admissions across the entire Zion network.

## 2. Core finding: a global order requires a global serialization mechanism

Suppose project A and project B have independent committees and are partitioned from each other. Each committee has locally valid committed history and sees the next founder ordinal as 417. If each committee remains able to admit users, both can commit ordinal 417. Deterministic execution inside each project does not prevent this cross-project conflict.

If both committees instead stop admitting users until they can coordinate, safety can be preserved, but admission availability is sacrificed during the partition. If they proceed independently and reconcile later, a previously issued ordinal or admission may need to be revoked/reordered, violating finality and the promised contiguous sequence.

This is not fixed by:
- hashing an identity or invitation ID into an ordinal (hashes do not encode admission order);
- choosing the lowest project ID or a deterministic tie-break after the fact (the committees still need a shared set of competing committed admissions);
- allocating ordinal ranges to projects (ranges either leave gaps, cease to mean the first 1,000 network-wide admissions, or require a globally coordinated range-allocation authority);
- a DHT, gossip, replicated event log, signed ACK, or threshold authorization certificate (none alone supplies one canonical total order);
- eventually reconciling independently committed project histories (reconciliation cannot preserve both independent finality and a single irreversible first-come-first-served sequence).

Therefore, under the stated first-come-first-served and contiguous-global-ordinal semantics, the network needs a linearizable/global ordering point for admission decisions. That ordering point can be a BFT state machine rather than a conventional centralized server, but it is still a network-wide consensus domain and a global logical authority for this one operation.

## 3. Architecture options

### Option A — Dedicated Zion-wide admission BFT domain

Create a narrow consensus domain whose only consensus-critical responsibility is user admission:
- invitation issue/revoke/consume commitments;
- idempotent redemption operation results;
- recipient membership and admission sequence;
- the global founder ordinal 1..1,000;
- committed state root and durable recovery.

Project committees remain independent for project governance, project membership, and project state. The admission domain is not a global blockchain for all Zion activity; it is a global consensus service for the product's explicitly global admission invariant.

**Guarantees:** can provide one canonical admission order and unique contiguous founder ordinals if the selected BFT protocol, validator-set governance, quorum assumptions, durable application contract, and client verification are correctly specified and implemented.

**Costs / risks:** this is a global admission committee/domain. It must be acknowledged as such, with a threat model for validator capture, quorum loss, censorship, liveness, validator rotation, genesis trust, and network partitions. It conflicts with a literal prohibition on any global committee, even though it does not centralize all project state.

**Partition behavior:** no quorum or no verifiable commit means no new admissions. This preserves safety but reduces availability.

### Option B — Project-scoped founder cohorts

Each project independently assigns its own first 1,000 founder ordinals.

**Guarantees:** project-local consensus can order each project's cohort without a Zion-wide serialization point.

**Costs / risks:** this changes the product meaning. Zion would no longer have one first-1,000 network-wide cohort. The same person could be founder in more than one project, and there would be no single network-wide ordinal. The UI, legal/product copy, invitation policy, identity model, and founder benefits would need explicit revision.

**Approval required:** yes. This is a product-policy change and must not be implemented implicitly.

### Option C — Global non-sequential founder slots

Define 1,000 unique founder slots and let independently governed domains claim disjoint slots under a separately specified allocation rule.

**Guarantees:** disjoint preassigned slots can prevent duplicate slot IDs without a live global counter, if allocation itself is trusted and immutable.

**Costs / risks:** this does not automatically mean “the first 1,000 admitted users.” Static partitions can strand slots, produce gaps, and let one project exhaust its allocation while another has unused capacity. Dynamic redistribution of unused slots reintroduces coordination. A slot ID is not a contiguous admission ordinal.

**Approval required:** yes, because it changes the meaning of first-come-first-served and requires a new allocation/fairness policy.

### Option D — Asynchronous reconciliation of project histories

Allow projects to admit independently, then merge their signed admission histories into a global ordering later.

**Finding:** rejected for the current invariant. A deterministic tie-break can produce a stable final ordering, but it cannot guarantee that the final order matches the actual first 1,000 admissions in real time. It may also invalidate already displayed founder status and previously consumed invitations. If provisional status is acceptable, that is a different product contract and must be approved explicitly.

## 4. Comparison

| Property | A: global admission BFT | B: project cohorts | C: distributed slots | D: later reconciliation |
|---|---|---|---|---|
| One Zion-wide first-1,000 cohort | Yes | No | Not necessarily | Not reliably in real time |
| Unique global contiguous ordinals | Yes, with correct BFT | No, only per project | Unique slots, not necessarily contiguous | Only after reordering; not first-come-first-served |
| Project committees remain independent | Yes, outside admission | Yes | Potentially | Yes, until reconciliation |
| Requires global admission ordering | Yes | No | Initial allocation or coordination | Reconciliation |
| Safe admission during partition | No; fail closed without quorum | Within each project | Only within preallocated slots | Provisional only |
| Product-policy change | No, but acknowledges global admission domain | Yes | Yes | Yes |

### 4.1 Dimension-by-dimension comparison

The table in §4 answers "does each option preserve the stated semantics". The decision also has to be made on the dimensions that determine whether the mechanism is safe and operable. Nothing here selects an option.

| Dimension | A: global admission BFT | B: project cohorts | C: distributed slots | D: later reconciliation |
|---|---|---|---|---|
| Safety of the founder set | One order; safe under its own quorum assumptions; safety depends entirely on the new domain's genesis bootstrap, validator governance and reconfiguration rules | Locally safe, globally inconsistent: the same identity can be founder in several projects and ordinals collide across projects | Safe slot uniqueness only if allocation is immutable and itself trusted; no contiguous order | No real-time safety: an ordinal can be displayed and then reordered. Needs explicit provisional semantics |
| Decentralization | Introduces one narrow global trust domain. Its committee, genesis and recovery become the network's most valuable capture target | Preserves the current no-global-committee direction, at the cost of the product invariant | Allocation authority becomes the capture target unless the split is fixed before genesis | Preserves independence; reconciliation rule becomes the capture target |
| Availability during partition | Fails closed: no quorum means no admissions at all, network-wide | Continues per project | Continues only inside preallocated slots | Continues, but with unresolved status |
| Throughput and DoS surface | Every redemption is globally serialized: admission rate is bounded by one committee's commit rate, and invitation spam becomes global censorship/queue pressure on the most security-critical domain | No global bottleneck | Bounded by slot allocation | No bottleneck until reconciliation |
| Sybil resistance | Reduces to "who was admitted first". Unlimited one-time invitations with no quotas mean identity growth is not rate-limited by consensus; the cost must come from anti-abuse policy outside the consensus domain (see `FAIR_USE_AND_ANTI_ABUSE.md`) | Same, per project, but a Sybil can farm founders in several projects | Same, plus slot concentration risk | Same, plus Sybil can exploit reordering races |
| Founder condition as historical fact | Enforceable: ordinal is committed once and never reassigned | Enforceable per project only | A slot ID is not history | Ordinal is not final until reconciliation |
| Product impact | Preserves the promise exactly; requires disclosing that admission is globally ordered | Changes the promise; requires explicit product approval | Changes the promise to "1,000 slots, not one cohort"; requires approval | Changes the promise to "provisional founder status"; requires approval |
| Operational cost | New genesis ceremony, committee operations, monitoring, recovery, and independent security review | Lowest | Medium; allocation ceremony | Medium; reconciliation service or rule |

Two properties of the current requirement deserve emphasis because they bound every option:

1. **Founder status is historical, not a permanent privilege.** Once an ordinal at or below 1,000 is committed, later policy changes must not be able to revoke it or create new founders retroactively. That is a property of the committed state machine, not of the ordering mechanism, and it must be tested for options A, B and C alike.
2. **Unlimited one-time invitations mean the consensus layer is not the Sybil boundary.** The protocol's Sybil resistance comes from the admission being attributable to an already admitted issuer plus whatever abuse controls operate outside the invitation quota. A global ordering domain adds a serialization point and a censorship surface; it does not add Sybil resistance.

### 4.2 Option E — batched global ratification with explicit provisional status

A fifth option is worth recording because it sits between A and D and is the only way to keep admission availability during partition without giving up eventual global uniqueness:

- each project admits locally and shows the user a provisional "pending global ratification" status with no ordinal;
- a narrow global domain later ratifies batches, assigning the single global ordinal sequence in ratification order;
- an ordinal, once ratified, is final; a provisional admission that loses the race is admitted but not a founder.

This preserves eventual uniqueness, availability and the historical-finality property for ratified ordinals. It does not preserve real-time first-come-first-served: a user admitted earlier in a partitioned project can lose the ordinal to a user admitted later in a better-connected project. That is a product-contract change (provisional status must be visible in the UI and in policy copy) and must be approved explicitly, exactly like Options B, C and D.

### 4.3 What the analysis cannot decide

Three inputs are product or governance decisions and must not be inferred by an implementation:

1. Whether a single network-wide founder cohort is required at all (if not, Option B is the cheapest and needs no new trust domain).
2. Whether provisional founder status is acceptable (if yes, Option E dominates D).
3. If a global ordering domain is required, whether a *narrow* global admission domain is permitted by the "no global committee" constraint. That constraint currently does not distinguish "global chain for all project state" from "global consensus for the admission operation only".

If input 1 or 2 is answered as "no change acceptable", Option A is the only analysed option that keeps the promise, and its genesis bootstrap can reuse the multi-governor canonical manifest codec described in `PROJECT_GENESIS_AND_VALIDATOR_ROTATION_SPEC.md` §9.1 — the admission domain needs its own authenticated genesis exactly like a project does. That codec verifies signatures and binds a manifest; it does not constitute the domain, the committee, or the admission state machine.

## 5. Recommendation under the current product requirement

If “first 1,000 Zion users” and contiguous global ordinals are non-negotiable, Option A is the only option in this analysis that directly preserves the stated semantics. The architecture should explicitly acknowledge a dedicated Zion-wide admission BFT domain while keeping project state and project validator committees independent.

This recommendation is conditional, not an authorization to implement or deploy a global committee. It means the no-global-committee constraint must be clarified: does it prohibit a global chain/committee for all project state, or does it prohibit even a narrow global admission consensus domain? Those are materially different constraints.

If any global admission consensus domain is prohibited, the existing first-1,000 network-wide product promise must change. Options B or C require explicit product approval; Option D does not preserve real-time first-come-first-served founder status.

## 6. Required design gates before implementation

If Option A is explicitly accepted, a separate design ADR must define, before code:
1. admission-domain genesis and network ID binding;
2. validator membership, voting power, quorum threshold, rotation, and recovery;
3. the BFT engine/version and exact finality/commit proof verified by clients;
4. how the admission committee is bootstrapped without circular trust;
5. deterministic state machine commands for invitation issue, revoke, redeem, and membership;
6. atomic persistence of consumed invitation, admitted identity, founder ordinal, operation result, and state root;
7. idempotent retry semantics for ambiguous client timeouts;
8. partition and quorum-loss behavior (fail closed);
9. state sync, snapshots, pruning, and recovery;
10. Sybil resistance, invitation abuse controls, privacy, and key revocation;
11. cross-runtime canonical serialization and signature test vectors;
12. adversarial and independent security review.

The current governance module, signed event replication, project committees, and local journal prototype must not be represented as satisfying these gates.

## 7. Current implementation boundary

No user invitation redemption, global founder counter, global admission committee, or production membership mutation is implemented by this analysis. No runtime path is changed. Existing invitation redemption remains unavailable until the architecture decision and implementation gates are satisfied.

The only admission-adjacent code merged on this branch is a codec: `poc/cometbft-verifier/genesis_manifest.go` encodes and verifies a canonical multi-governor genesis manifest. It cannot order admissions, consume invitations, assign ordinals, or operate a domain, and it is not wired into any runtime path.

This document does not authorize merge, deployment, release, production database changes, or changes to the project's validator architecture.
