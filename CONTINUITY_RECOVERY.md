# Zion continuity recovery — v0.33.32

## Purpose

This release repairs gaps found during continuity auditing of the v0.33.31 package. It preserves the source tree, restores audit reports already available in the local evidence directory, reconstructs omitted changelog entries from existing reports/packages, and creates a separate preservation bundle with release archives and test logs.

## Evidence basis

- Base source tree: `zion_work_03331` / release `v0.33.31`.
- Restored audit files: `AUDIT_V0.33.20.md` and `AUDIT_V0.33.30.md`, copied from the preserved local evidence directory.
- Changelog additions for v0.33.25–v0.33.31 are summaries derived from preserved audit reports and package artifacts, not a reconstruction of deleted chat messages.
- Previous ZIPs and available `.sha256` files are retained in the preservation bundle.

## Explicit limits

This process cannot prove that every requirement discussed in a deleted conversation was implemented. It cannot recover conversation-only decisions that were never committed to source, tests, or documentation. No GitHub deployment or production rollout is implied by this local recovery release.

## Verification commands

Run with Node.js 20 or newer:

```sh
npm test
npm run check
npm run demo
npm run client:demo
```

The preservation bundle also contains the logs that were available at the time of packaging and a SHA-256 manifest for every included file.
