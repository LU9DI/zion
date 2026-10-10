# Zion v0.33.22 — External rollback and freshness policy audit

## Scope

This release extends the offline trusted checkpoint-chain verifier with an optional, externally authenticated rollback/freshness policy. It is additive and read-only; v0.33.21 behavior remains when no policy is supplied.

## Changes

- `scripts/verify-trusted-checkpoint-history.js`: optional `rollbackPolicy` with `schemaVersion: 1`, `minimumRevision`, `expectedLastCheckpointSha256`, `minimumHeadIssuedAt`, and `maxHeadAgeMs`.
- The policy is evaluated only after the full signed chain, rotations, and revocations have been validated.
- Head freshness applies only to the latest checkpoint; historical checkpoints are not incorrectly required to be recent.
- `scripts/verify-trusted-checkpoint-history-cli.js`: optional sixth `rollback-policy.json` argument, bounded to 64 KiB and read through the existing no-follow/metadata checks.
- `package.json`: version `0.33.22`.
- README and CHANGELOG document provisioning and usage constraints.
- Two new adversarial tests cover revision rollback, head hash pinning, stale heads, malformed policy, and future-dated heads.

## Validation performed

- Targeted tests: 6 passed, 0 failed.
- Full test suite: 487 passed, 0 failed.
- `npm run check`: passed for 150 JavaScript files.
- `npm run demo`: exit code 0; demo reports optional telemetry unavailable, as expected in this environment.
- ZIP integrity and SHA-256 are checked after packaging.

## Security boundaries

- The rollback policy must be provisioned/authenticated independently. If an attacker can replace both the history and the policy, policy enforcement alone cannot prevent rollback.
- `minimumRevision` and `minimumHeadIssuedAt` provide lower bounds; exact head pinning uses `expectedLastCheckpointSha256`.
- `maxHeadAgeMs` constrains only the newest checkpoint. It does not establish freshness of rotation/revocation state unless those source bundles also have a separately managed freshness policy.
- Offline verification cannot contact a registry or prove that externally provisioned policy data is the globally latest state.
- Filesystem metadata checks reduce but do not eliminate every possible race on every OS/filesystem.
- No GitHub publication or production deployment was performed.
