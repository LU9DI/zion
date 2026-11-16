# User invitation protocol ADR

Status: **design decision recorded; implementation blocked on distributed commit**
Scope: PR #68, branch `architecture/fully-decentralized-core`

## Context

Zion's product policy is invitation-only onboarding. The first 1,000 successfully admitted user identities are the founding cohort. Every admitted user, including every later invitee, may issue an unlimited number of invitations. Each invitation may be redeemed once.

The repository currently has experimental local identity registration, peer-introduction vouchers, peer admission, and project-governor state. None is a globally authoritative user invitation system.

## Decision

Define user invitations as a separate domain protocol. Do not reuse peer-introduction vouchers or the peer-admission controller as the user invitation authority.

A future implementation MUST treat invitation redemption, recipient admission, and founding ordinal assignment as one atomic transition in the network's canonical, quorum-committed state. The current governance state machine and signed event replication journal are not BFT consensus and cannot provide that guarantee by themselves.

### Invitation object

The wire object should contain only bounded, versioned fields:

- protocol and policy version;
- network/genesis identifier;
- globally unique invitation identifier;
- issuer Zion identity ID;
- commitment/hash of a high-entropy random bearer secret (never the raw secret in replicated state);
- creation and optional expiry timestamps;
- optional recipient identity binding or an explicit claim-flow binding;
- issuer signature over the canonical object.

The bearer secret must be generated with a cryptographically secure random generator. The recipient presents the secret over an authenticated, protected channel. The network verifies the issuer signature, network binding, expiry, revocation state, secret commitment, and recipient binding before proposing admission.

### Canonical state transition

The future state machine should expose deterministic operations equivalent to:

1. `ISSUE_USER_INVITATION`: authorize any already admitted user as issuer; add a unique invitation commitment. There is no per-issuer count quota. Resource/abuse controls may reject abusive traffic without imposing an arbitrary lifetime invitation quota.
2. `REVOKE_USER_INVITATION`: mark an unredeemed invitation revoked. Revocation and redemption races resolve by canonical commit order.
3. `REDEEM_USER_INVITATION`: validate the invitation and recipient's proof of possession; atomically mark the invitation consumed and admit the recipient identity.
4. Assign the next founding ordinal in that same committed admission transition if fewer than 1,000 founding identities have been committed. After ordinal 1,000, admissions remain valid but are not founders.

The same invitation cannot create two admissions, even if multiple nodes receive concurrent redemption requests. A stable operation ID must make retries idempotent after lost responses or ambiguous client timeouts.

### Required invariants

- Every admitted user can issue invitations; founder status is not an authorization condition.
- No per-user invitation issuance quota exists.
- An invitation identifier and secret commitment can be consumed at most once globally.
- The issuer, recipient, network, policy version, and admission result are cryptographically attributable.
- The founding ordinal is assigned only by the canonical committed transition and is unique, contiguous, and bounded to 1..1000.
- Nodes with stale state, conflicting histories, unavailable quorum, or uncertain commit outcomes fail closed for new admissions.
- Local caches, web-server counters, GitHub Actions, DHT records, and a single database are never authoritative for invitation consumption or founding status.
- Expiry and revocation are checked against deterministic network time/height semantics, not each node's wall clock alone.
- Anti-abuse and capacity controls protect the network without silently reintroducing a per-user invitation quota.

## Explicit non-decisions

- This ADR does not select or implement a BFT consensus engine.
- It does not claim the existing project-governance primitive is a quorum-commit protocol.
- It does not define a production account/session system, email delivery, or hosting provider.
- It does not authorize deployment, release, migration, or removal of transitional PostgreSQL code.
- It does not promise anonymity: invitation lineage is auditable by protocol participants, subject to a separately specified privacy model.

## Existing code assessed

- `src/social-identity-directory.js`: local persistent identity directory with proof of possession; it explicitly lacks global conflict resolution and Sybil resistance.
- `src/peer-introduction-vouchers.js`: signed, time-limited peer introduction statements; these are for node introductions, not user signup.
- `src/peer-admission-controller.js`: local serialized admission coordinator with trusted-introducer threshold, per-issuer quota, and local state store. Its own comments state that multi-process operation needs transactional shared storage. It is not a global network consensus mechanism.
- `src/admission-rollout-policy.js`: local operator-controlled rollout caps; not a global founding cohort counter.
- `src/project-governance.js`: deterministic governor state transitions and threshold approvals; its own contract says approvals alone are not a consensus certificate.

None of these components currently satisfies the user invitation protocol.

## Implementation gates

Implementation must not be called production-ready until all of the following pass:

1. Canonical serialization and signature verification test vectors across supported runtimes.
2. Random secret entropy and commitment tests; raw secrets never appear in replicated logs or diagnostics.
3. Concurrent issuance and concurrent redemption across independent processes and nodes.
4. At most one successful redemption for the same invitation under race, retry, partition, restart, and ambiguous-commit scenarios.
5. Exactly 1,000 founder ordinals under concurrent admissions; no duplicate, gap, or ordinal 1,001.
6. Every admitted identity (founder and non-founder) can issue invitations without a count cap.
7. Wrong-network, wrong-recipient, forged signature, altered commitment, expired, revoked, replayed, and malformed invitations are rejected.
8. Partition/quorum loss prevents new admissions without creating divergent founding ordinals.
9. Peer synchronization and restart preserve consumed/revoked state and issuer attribution.
10. Independent adversarial review of the selected BFT and invitation state transition.

## Consequences

This design preserves the unlimited-invitation product policy without confusing it with node admission or pretending a local database/controller is decentralized. The immediate implementation dependency is a proven canonical BFT commit layer and a replicated user-membership state machine. Until then, user invitation redemption must remain unavailable rather than being represented as globally safe.


## Architecture scope blocker — global founding ordinal versus project-scoped consensus (2026-11-14)

The current BFT evaluation requires independent, project-scoped validator committees and committed histories, with no global chain or global validator committee. This ADR requires one Zion-wide, contiguous founding ordinal sequence (1..1,000) bound to a network/genesis identifier.

A project-scoped committee alone cannot serialize a single global founder counter across independent projects: two committees could concurrently assign the same next ordinal. A local database, website counter, DHT record, GitHub workflow, or cache cannot be used to bridge that gap because this ADR already forbids them as authorities.

This is unresolved and blocks implementation of `REDEEM_USER_INVITATION` and founder assignment. The architecture must explicitly choose between:

1. a separate Zion-wide admission consensus domain (which is a global admission committee/authority even if it is not a global blockchain, and must be reconciled with the no-global-committee requirement);
2. changing founder ordinals to be project-scoped (a product-policy change requiring explicit approval); or
3. a fully specified alternative protocol that proves globally unique, contiguous ordinals without a global serialization authority. No such protocol is currently specified.

Until resolved, invitation redemption and global founder assignment remain unavailable. Project-scoped BFT evaluation may continue independently. See `docs/PROJECT_COMMITTED_STATE_MACHINE_CONTRACT.md`, section 2.


## Follow-up architecture analysis (2026-11-15)

The global-ordering conflict has been analyzed in
`docs/ZION_WIDE_ADMISSION_CONSENSUS_OPTIONS.md`. Under the current product
semantics (one network-wide first-1,000 cohort with unique contiguous
first-come-first-served ordinals), a dedicated Zion-wide admission BFT domain
is the only evaluated option that directly preserves the invariant. It is
still a global admission consensus domain and therefore requires an explicit
clarification of the existing no-global-committee constraint.

Project-scoped cohorts and distributed non-sequential founder slots change
the product semantics and require explicit approval. Asynchronous
reconciliation does not preserve irreversible real-time first-come-first-served
founder status.

No option is approved for implementation by this analysis. Invitation
redemption and global founder assignment remain blocked pending an explicit
architecture/product decision and the design gates in the analysis document.



## Follow-up ABCI++ commit/finality source audit (2026-11-15)

The exact CometBFT `v0.38.26` ABCI++ API, consensus finalization path, commit evidence, validator-set verification, and crash-recovery contract have been source-audited in [`docs/COMETBFT_0_38_26_ABCI_COMMIT_CONTRACT_AUDIT.md`](COMETBFT_0_38_26_ABCI_COMMIT_CONTRACT_AUDIT.md).

The audit confirms that `FinalizeBlock` returns the deterministic application hash and execution results, while `Commit` persists application state and its response does not carry a quorum certificate. The current block's commit evidence is held by CometBFT, not passed to the application as the current `FinalizeBlock` request's `decided_last_commit` field (that field describes the previous commit). Independent clients therefore need a specified signed-header/commit and validator-set verification path; a local application callback or server response is not a portable finality proof.

This is an upstream API/source audit only. It does not select CometBFT for Zion, establish a runtime integration, resolve the global-versus-project admission scope conflict, or authorize invitation redemption implementation. The database atomicity, authenticated light-client trust root, validator bootstrap, and fault-tested recovery gates remain open.
