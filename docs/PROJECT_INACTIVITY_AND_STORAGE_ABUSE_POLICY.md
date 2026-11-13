# Project inactivity and storage-abuse policy

Status: **experimental controller and migration schema prepared; runtime enforcement is not active**.

The project-scoped lifecycle controller is implemented in
`src/project-inactivity-controller.js`, with focused unit tests in
`tests/project-inactivity-controller.test.js`. It uses a repository-provided
project lock/fence and explicit storage adapters. The production repository
implementation, durable scheduler, notification delivery, storage migration
adapter, and full race/restart integration tests are still required. Do not
represent this feature as active in a deployed node.

This policy is separate from the existing experimental
`InactivityResourcePolicy`, which tracks owner/node contribution activity and
has different defaults. The project policy is the authoritative requirement for
project inactivity: pause at 7 days, release storage reservation at 15 days.

## 1. Inactivity lifecycle

The authoritative clock is the last **verified meaningful project activity**.
Thresholds are fixed by the current product decision:

| Idle period | Project state | Required behavior |
| --- | --- | --- |
| Before 7 days | `active` | Normal policy and quota enforcement |
| 7 consecutive days | `paused` | Pause project execution and new writes; preserve read/export and owner recovery access |
| 15 consecutive days | `storage_release_pending` then `storage_released` | Withdraw the project's storage reservation from contributing nodes only after safe relocation or an explicitly approved retention/archival path is verified |

The 7-day and 15-day clocks are measured from the same last meaningful activity
timestamp, not from the time the pause job happens to run. Scheduler downtime
must not reset or extend the deadline. Evaluations must be idempotent and safe
across concurrent workers and restarts.

A project may be reactivated by an authenticated owner action. Before accepting
writes or compute work, the control plane must reacquire capacity and re-check
policy, identity, quota, and content-admission requirements. Reactivation must
not silently recreate a storage reservation that has already been released.

## 2. What counts as meaningful activity

Count only successful, authenticated, project-scoped actions that represent
real owner or authorized collaborator work, such as:
- a completed user-initiated upload or replacement that changes project content;
- a completed download or restore initiated by an authorized user;
- a committed project configuration or source change;
- a user-initiated project operation that produces a durable, verifiable state change.

Do **not** refresh activity for:
- health checks, pings, heartbeats, presence, telemetry, dashboard polling;
- background replication, garbage collection, anti-virus scans, maintenance;
- billing, quota checks, notifications, scheduler runs, or internal metadata reads;
- failed, cancelled, duplicate, replayed, or automatically retried requests;
- synthetic traffic, keep-alive loops, or activity generated solely to evade expiry.

Record event type, project ID, authenticated actor identity, server timestamp,
idempotency key, outcome, and a minimal audit reference. Do not store plaintext
file content or secrets in the activity ledger. Use server-side timestamps and
deduplicate events; clients must not be allowed to set or backdate
`last_meaningful_activity_at`.

## 3. Safe pause and storage release

At day 7:
- stop new project execution, scheduled jobs, writes, and new capacity consumption;
- allow owner authentication, status inspection, data export, and reactivation;
- preserve durable project metadata and user data;
- notify the owner through configured channels and record delivery outcome;
- do not count system-generated notification or retry traffic as activity.

At day 15:
- mark the lease as expiring/release-pending under a transaction/lease fence;
- stop placing new replicas for the project on the contributing node;
- relocate required replicas to eligible independent nodes and verify read-back,
  ciphertext digest, byte count, replica identity, and durability receipt;
- only then release the node's reserved capacity and record the release;
- if migration or verification fails, retain the reservation and data, keep the
  project in a safe restricted state, and retry with bounded backoff plus alerting.

**Releasing a capacity reservation is not permission to delete user data.**
Deletion, cryptographic erasure, or expiry of the last copy requires a separate,
explicit retention policy, owner notice, legal-hold check, and recoverability
decision. Never silently destroy the only copy to satisfy a capacity target.

## 4. Anti-filler and storage-abuse controls

The goal is to stop artificial monopolization, not to judge whether a user's
files are useful. Do not classify files as useless based only on filename,
extension, content type, small size, entropy, or lack of downloads.

Required controls:
- charge storage by verified **unique ciphertext bytes actually retained**;
  content-addressed deduplication must not grant extra quota for duplicate copies;
- enforce per-project, per-owner, and per-node caps for reserved bytes, stored
  unique bytes, object count, upload rate, concurrent transfers, and churn;
- reject empty/invalid protocol segments and enforce bounded object/chunk sizes,
  archive expansion limits, and request deadlines;
- detect repeated identical uploads, rapid create/delete cycles, large volumes
  of near-identical objects, and reservation patterns inconsistent with policy;
- require authenticated, idempotent storage requests and verify committed bytes
  by read-back before crediting storage or issuing receipts;
- use fair-use budgets and adaptive throttling before punitive action;
- quarantine suspicious uploads only under a documented, privacy-preserving
  inspection policy; encrypted content must not be silently decrypted by peers;
- make enforcement decisions explainable, auditable, appealable, and reversible
  when evidence is insufficient.

A file's apparent lack of utility is not proof of abuse. A legitimate backup,
dataset, cache, test fixture, or small/empty file remains allowed within quota.
Do not introduce proof-of-work, deposits, slashing, or identity bans as automatic
defaults: those require a separately reviewed governance and Sybil-resistance
design. The current in-memory `UploadStakeLedger` is only an accounting example
and is not production enforcement.

## 5. Durable state and concurrency invariants

The implementation must provide:
- a durable project registry with owner/ACL and lifecycle state;
- an append-only, idempotent meaningful-activity ledger;
- storage leases scoped to project and contributing node, with reserved,
  active, release-pending, and released states;
- verified per-project/node usage and unique-byte accounting;
- an abuse-event/audit trail with evidence references and policy version;
- transactional state transitions with row/advisory locks or equivalent fencing;
- monotonic server timestamps and protection against stale scheduler workers;
- bounded retries, dead-letter/alert handling, and restart recovery;
- retention/legal-hold checks before any data deletion.

The experimental controller expects a repository adapter to serialize activity
writes and lifecycle evaluations using the same project-level lock. It rechecks
the activity timestamp and live lease set after replica relocation and before
capacity release. The adapter must guarantee these operations are transactional
and fenced; the controller alone cannot provide that guarantee.

## 6. Required validation before activation

Focused unit tests currently cover:
- exact 7-day and 15-day boundaries;
- non-meaningful activity not refreshing the clock;
- verified relocation before capacity release;
- failed relocation and unconfirmed capacity release leaving the reservation pending;
- no data deletion during reservation release.

Before production activation, add integration tests for:
- duplicate/replayed events and idempotency under database concurrency;
- valid activity racing with pause and storage release;
- concurrent schedulers and process restart recovery;
- pause preserving owner read/export and preventing new writes/jobs;
- real replica read-back, ciphertext digest, byte count, replica identity and durability receipt;
- reactivation after pause and after released capacity;
- duplicate uploads not consuming additional unique-byte quota;
- burst uploads, object-count exhaustion, rapid churn, and multi-identity abuse;
- legitimate small files and backups not being falsely penalized;
- missing, stale, or contradictory usage telemetry failing closed.

## 7. Implementation order

1. Project registry, ACL, durable activity ledger, and lifecycle state machine.
2. Project/node storage leases and verified usage accounting.
3. Idempotent 7-day pause and 15-day safe capacity release.
4. Anti-filler detection, quotas, fair-use throttling, quarantine, and appeals.
5. Deployment integration and independent security/resilience testing.

Abuse controls for compute hours, build minutes, and deploy frequency are
intentionally deferred until the final implementation stage, as requested.

## 8. Durable storage-accounting schema (migration 0003)

Migration `0003_project_storage_accounting.sql` adds the persistence structures
needed for the next enforcement layer:
- content-addressed ciphertext blobs, uniquely keyed per project by SHA-256;
- logical objects referencing a blob, with a composite foreign key that prevents
  cross-project blob attachment;
- idempotent upload event history with declared and independently verified byte
  counts, outcomes, and bounded rejection categories;
- expiring concurrent-upload leases;
- project/owner/node quota records for unique bytes, object count, upload rate,
  concurrent transfers, churn, and archive expansion;
- immutable usage-audit snapshots with evidence digests.

The migration deliberately defaults quota records to `enabled = false`. The
schema alone does not enforce admission, count bytes, inspect archive contents,
or prevent uploads. Those operations require transactional repository methods,
a trusted storage read-back verifier, authenticated API integration, and
concurrency tests. Apply migration 0003 only after migration 0002 has been
reviewed and explicitly approved for the target database.
