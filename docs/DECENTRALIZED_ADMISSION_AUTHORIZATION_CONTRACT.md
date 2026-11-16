# Decentralized admission and authorization contract

Status: **source-derived migration contract; no implementation or backend replacement is claimed**  
Scope: PR #68, branch `architecture/fully-decentralized-core`

## 1. Purpose

Define the externally observable semantics that must survive when the official node stops using PostgreSQL for peer admission, revocation, capacity, and authorization. This is a storage-neutral domain contract, not a consensus algorithm.

The source of truth inspected for this contract is:

- `scripts/start-official-node.js`
- `src/postgres-peer-admission-runtime.js`
- `src/peer-admission-postgres-store.js`
- `src/peer-admission-postgres-controller.js`
- `src/peer-admission-postgres-listener.js`
- `src/peer-transport.js`

The current implementation remains PostgreSQL-backed. This document does not authorize launcher changes, database migrations, or removal of historical compatibility code.

## 2. Required committed state

The eventual project-scoped state machine must represent at least:

- project identifier and committed state version/digest;
- current governance epoch and governance authorization policy;
- validator committee epoch and validator membership/weights, separately from governors;
- peer admission status: absent, active, released, or revoked;
- durable revocation tombstones, including identities that were never admitted but were previously trusted as bootstrap peers;
- consumed invitation nonces, issuer identities, and the admitted subject;
- issuer admission counts or enough canonical history to derive them deterministically;
- active capacity reservations and the policy version under which each reservation was accepted;
- capacity and storage-headroom policy values, with deterministic units and integer representation;
- any lifecycle/lease/quota state whose transition can authorize or deny a network operation.

No peer-local cache, DHT record, transport session, gossip message, or replica ACK is authoritative. Such data may accelerate discovery or invalidation, but every security-sensitive operation must be checked against the latest locally verified committed state.

## 3. Required operations and atomicity

### 3.1 Admit peer

The existing PostgreSQL path validates the subject identity, distinct issuer identities, one invitation per issuer, unique invitation nonces, headroom ratio, and positive capacity/quota limits. Its transaction serializes by subject, policy, and capacity; it checks current policy and quotas, inserts the active admission, records issuers and consumed nonces, and increments active reservations.

The replacement must expose one deterministic transition that atomically:

1. validates project, subject, policy version, issuer set, and invitation evidence;
2. rejects duplicate subject admission and previously consumed invitation nonces;
3. verifies each issuer is authorized under the committed project epoch;
4. checks storage headroom and active capacity against committed policy;
5. checks issuer quotas against committed history;
6. creates the active admission and records all consumed invitation nonces;
7. increments the capacity reservation exactly once.

A retry with the same request identifier must return the same committed result, not consume quota/capacity twice. A conflicting request for an already consumed nonce must fail deterministically.

### 3.2 Revoke peer

Revocation must be a durable committed transition. A revocation for an identity with no admission row must create a tombstone; otherwise a peer admitted through bootstrap trust could reappear after restart.

The current implementation serializes revocation against application dispatch and decrements capacity only when transitioning from active. The replacement must preserve these semantics using committed sequence/epoch checks, not a local mutex or an uncommitted gossip notification.

Revocation must be idempotent. A released identity must not silently become revoked or active through a stale request. Revocation must invalidate prior authorization epochs and reject stale capabilities.

### 3.3 Release admission

Release and revoke both remove an active reservation, exactly once. Only an active admission may transition to released/revoked. Repeating the same terminal transition is idempotent; changing one terminal state into another is rejected unless a separately specified governance transition explicitly permits it.

### 3.4 Authorize an application operation

The PostgreSQL store currently holds a shared subject advisory lock while the application callback runs; revoke/release takes the exclusive lock. This linearizes a dispatch against revocation but holds a database connection and lock for the entire callback.

The replacement must define a bounded authorization linearization point. An operation must bind to a committed project state digest/epoch and peer admission version. A node must reject it if the required committed state is unavailable, if its local state is behind the operation's required epoch, or if a newer revocation is known/committed.

A long-running application callback must not require holding a distributed lock. Instead, define whether authorization is checked at dispatch, at commit, or both, and which side effects are forbidden until the required commit proof is obtained. No operation may claim that a local cache check is equivalent to a distributed fence.

### 3.5 Capacity and quota

Capacity reservation, release, and issuer quota accounting must be deterministic and replayable from committed transitions. Concurrent admissions must not overbook capacity across honest nodes. A local count or eventual gossip total is insufficient.

The design must specify behavior when peers disagree about available capacity, policy versions, or storage receipts: critical admissions stop until a valid commit is available. Storage receipts are evidence inputs, not a substitute for the committed reservation transition.

## 4. Transport and cache boundary

The current `PeerTransport` uses a PostgreSQL-backed controller/listener in official mode, a static trusted-peer allowlist, and a revocation notification channel. A notification is only a prompt to re-check durable state; it is not the authoritative revocation proof.

The decentralized path must:

- authenticate the cryptographic peer at transport level;
- separately verify project membership/admission against committed state;
- bind authorization decisions to project and epoch;
- treat DHT, peer exchange, seeds, and gossip as untrusted hints;
- make revocation propagation best-effort while committed state remains authoritative;
- reject critical operations when no valid committed state/quorum can be established;
- avoid a central database, hosted scheduler, CA, or mandatory bootstrap peer.

## 5. Commit-outcome ambiguity and retries

The PostgreSQL store deliberately marks a transaction outcome unknown if the connection fails after COMMIT begins and refuses automatic replay. The decentralized replacement must preserve this safety property.

A proposer or client that loses the response to a commit must query/reconcile by deterministic operation ID and committed state. It must never blindly resubmit a non-idempotent admission, quota, or capacity operation. The canonical transition format must include an operation ID and deterministic result digest.

## 6. Required interfaces (conceptual only)

A future storage-neutral domain boundary should provide operations equivalent to:

- `getCommittedProjectState(projectId)`
- `proposeAdmission(command)`
- `proposeRevocation(command)`
- `proposeRelease(command)`
- `authorizeOperation(peerId, projectId, requiredEpoch, operation)`
- `getCommittedOperationResult(projectId, operationId)`

The implementation must distinguish proposal acceptance, quorum commitment, local persistence, and application of a committed transition. A function returning `ok: true` must not blur these states.

No concrete JavaScript interface, adapter, or BFT library is selected by this document.

## 7. Migration acceptance gates

Before the official launcher can stop requiring PostgreSQL:

1. A selected and reviewed BFT engine must commit this state machine with explicit safety/liveness assumptions.
2. Two or more independent processes must produce identical state digests from the same genesis and committed history.
3. Concurrent admission tests must prove no capacity or issuer-quota overbooking.
4. Duplicate/reordered/replayed invitations and operation IDs must be rejected or return the original result.
5. Revoke-vs-dispatch and release-vs-dispatch races must have a documented linearization rule and adversarial process tests.
6. Restart/crash injection at every durable vote, commit, apply, and response boundary must preserve safety and recover deterministically.
7. Partitions and loss of quorum must stop critical mutations without split-brain or hosted fallback.
8. Validator reconfiguration and governance-key revocation must preserve the commit history and reject stale epochs.
9. The official node must start and operate with no database URL, PostgreSQL adapter, hosted scheduler, CA, or mandatory seed.
10. Historical PostgreSQL data must have a separately reviewed import/verification plan before any compatibility data is retired.

CI success on unit tests alone is not sufficient evidence for these gates. Multi-process tests, deterministic fault injection, reproducible state-digest checks, and independent protocol review are required.

## 8. Explicit non-claims

- This contract is not a distributed lock or consensus protocol.
- It does not prove BFT safety, liveness, Sybil resistance, or DoS resistance.
- It does not implement admission, revocation, quota, or capacity replacement.
- It does not authorize any PostgreSQL migration, Neon change, launcher cutover, merge, deployment, or release.

## 9. Deterministic transition refinement

The operation-envelope, idempotency, state model, logical-capacity boundary, deterministic replay, and recovery requirements are refined in `docs/DECENTRALIZED_TRANSITION_STATE_MACHINE_SPEC.md`. That document is a specification gate only; it does not implement a state machine or select consensus.
