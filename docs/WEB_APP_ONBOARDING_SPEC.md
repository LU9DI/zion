# Zion web application and invitation onboarding specification

Status: **product requirements recorded; implementation pending**
Scope: PR #68, branch `architecture/fully-decentralized-core`

## 1. Product requirements

- The web application is the primary user-facing entry point and must be usable in a browser on desktop and mobile.
- All user-facing interface copy is English: navigation, forms, validation, empty states, notifications, settings, help, transactional email, and invitation flows.
- The UI must remain simple, functional, responsive, accessible, and fast.
- Zion is invitation-only. There is no public self-service registration without a valid invitation.
- The first 1,000 users form the founding cohort and receive invitation privileges.
- Each founding user may issue an unlimited number of invitations. There is no per-user invitation quota.
- Each invitation must be redeemable only once. Unlimited issuance does not mean reusable codes or anonymous/unaccountable admission.
- GitHub is the source/build/release workflow requested for the web app; GitHub must not become a mandatory runtime dependency for the decentralized network.

## 2. Separate web-account onboarding from peer admission

The existing repository has two experimental mechanisms that must not be conflated with the product's web invitation system:

1. `src/social-identity-directory.js` registers a cryptographic social identity locally using proof of possession.
2. `src/peer-introduction-vouchers.js` creates short-lived, issuer-signed peer-introduction vouchers. `src/peer-admission-controller.js` currently requires multiple trusted issuers and enforces per-issuer admission quotas. This is a peer-admission mechanism, not a complete web-account invitation system.

The web invitation flow needs its own explicit domain contract and must bind a redeemed invitation to the new Zion identity. It must not silently reuse the peer-introduction voucher rules or claim that local process state is globally authoritative.

## 3. Founding cohort and unlimited invitations

The founding cohort rule is a global network rule, not a per-node counter:

- The founding cohort contains exactly the first 1,000 successfully admitted user identities under the canonical genesis/admission history.
- Founding status and invitation-issuing eligibility must be deterministic and independently verifiable by every honest node.
- A local counter, a single web server, a GitHub workflow, or an eventually consistent DHT record cannot decide who belongs to the first 1,000.
- The admission transition must atomically assign the next founding ordinal while fewer than 1,000 founding identities exist.
- Every founding identity receives unlimited invitation issuance rights. No per-issuer count limit may be applied to founding invitation issuance.
- Invitation redemption remains single-use and globally replay-protected. A unique invitation identifier/nonce must be consumed in the same committed transition that admits the recipient.
- The invitation must be bound to the intended recipient identity (or to a securely defined claim flow), the issuer, the network/genesis identifier, and the applicable policy version. Expiry and revocation semantics must be explicit.
- If no valid committed state or required quorum is available, the system must fail closed for admission rather than issue conflicting founding ordinals or accept a replay.

This specification does not select a BFT engine or claim that the current implementation can yet provide a globally consistent first-1,000 counter.

## 4. Invitation lifecycle

The eventual invitation protocol must define and test:

- cryptographically secure invitation secret generation;
- storage of only a hash/commitment of bearer secrets where applicable;
- issuer signature and identity binding;
- one-time redemption under concurrent attempts;
- deterministic duplicate/replay rejection;
- optional revocation before redemption;
- expiry and policy-version checks;
- audit evidence for issuer-to-recipient attribution without exposing private keys;
- safe handling of lost responses and retries using a stable operation identifier;
- rate limiting and abuse controls at the web edge, without treating those controls as a global invitation quota;
- recovery behavior after process crash, partition, and ambiguous commit outcome.

Unlimited invitation issuance is a product quota decision. It does not remove anti-spam controls, proof-of-possession requirements, one-time redemption, or network resource/capacity safeguards.

## 5. Web UI requirements

The current `cloud/` directory is a static interactive preview, not a production web application. Its README explicitly states that file uploads, node health, social interactions, and messages are simulated or local-only. The UI must not present those preview values as live network facts.

The web app should have, at minimum:

- an invitation-only landing and redemption flow;
- identity creation / sign-in based on the selected cryptographic identity lifecycle;
- an authenticated application shell;
- a dedicated invitations page showing issued, redeemed, expired, and revoked invitations;
- a clear invitation creation/share flow with no artificial per-user count cap for eligible founding users;
- honest loading, offline, quorum-unavailable, and error states;
- accessible keyboard navigation and responsive layouts;
- no hardcoded demo profiles, fake node health, or simulated file/message state presented as real data.

All visible text must be English. Keep UI strings separate from business logic so future localization does not require rewriting application behavior.

## 6. GitHub and deployment boundary

- Keep source, automated validation, and release workflow in GitHub.
- Inspect and document the actual hosting target and deployment workflow before adding deployment configuration.
- Do not assume GitHub Pages, Actions-hosted runtime, or any external host without a separately approved architecture decision.
- The decentralized network must continue operating if GitHub is unavailable after a signed release has been distributed.
- No deployment, release, merge, or infrastructure mutation is authorized by this specification.

## 7. Existing implementation gaps found during source inspection

- `cloud/README.md` identifies the UI as a Portuguese (Brazil) preview with no real account system or live cloud integration.
- `cloud/index.html` declares `lang="pt-BR"` and contains Portuguese user-facing copy.
- `cloud/app.js` seeds demo files/activity and contains local-only simulated interactions.
- `docs/SOCIAL_SESSION_AUTH.md` describes experimental process-local sessions; sessions are memory-only and do not synchronize across nodes.
- `docs/SOCIAL_IDENTITY_DIRECTORY.md` describes a local identity directory with no distributed conflict resolution or Sybil resistance.
- `src/peer-introduction-vouchers.js` implements peer-introduction vouchers with a maximum 30-day lifetime.
- `src/peer-admission-controller.js` defaults to a threshold of two trusted introducers and a maximum of five admissions per issuer. Those are existing peer-admission defaults, not the requested unlimited founding-user invitation policy.
- `src/admission-rollout-policy.js` has local rollout caps (25, 100, and 500 by default) and explicitly states that it is not a distributed/global network-wide cap.

These findings mean the requested onboarding system is not already implemented. The current code must not be described as supporting the founding cohort or unlimited invitations.

## 8. Product decision still required

The confirmed requirement grants invitation privileges to the first 1,000 users. It does not yet establish whether users who join through those invitations also receive unlimited invitation privileges, receive a smaller/conditional allowance, or cannot invite others.

That inheritance rule must be decided before implementing invitation authorization. The default implementation must not silently expand the unlimited-inviter privilege beyond the founding 1,000 users.

## 9. Acceptance gates

Before calling invitation onboarding functional:

1. English copy audit covers every rendered page, validation/error path, email, and accessibility label.
2. Founding ordinal assignment is deterministic across independent nodes and protected against concurrent admissions.
3. Exactly the first 1,000 committed identities receive founding invitation privileges.
4. Founding invitation issuance has no per-user count cap.
5. Concurrent redemption of the same invitation can produce at most one successful admission.
6. Issuer attribution and invitation replay protection survive restart and peer synchronization.
7. Admission stops safely when committed state/quorum is unavailable.
8. Tests cover expired, revoked, forged, wrong-network, wrong-recipient, replayed, and concurrently redeemed invitations.
9. The UI is connected only to real authenticated APIs; demo data is removed or unmistakably labeled as a demo.
10. Independent security review and multi-process adversarial tests precede production claims.

This document is a specification only. It does not implement invitations, account authentication, distributed consensus, deployment, or production readiness.
