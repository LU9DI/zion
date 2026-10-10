# Zion — recovery publication v0.33.32

This repository is being initialized from the preserved Zion v0.33.32 recovery artifacts.

## Current recovery status

- Source baseline: v0.33.31, repackaged as v0.33.32 for continuity documentation and metadata.
- Local verification recorded: 533 automated tests passed; syntax check passed for 166 JavaScript files; `npm run demo` and `npm run client:demo` exited successfully.
- Historical release archives currently preserved: v0.33.7 through v0.33.32. Releases v0.33.1–v0.33.6 were not found in the inspected backup set.
- The backup does not contain full transcripts of deleted conversations and cannot prove recovery of work that was never saved to files.

## Important publication note

This initial commit publishes the recovery documentation only. The complete 245-file source tree and preservation ZIP have **not yet been uploaded to this repository**. Do not treat this commit as a complete source publication or production release. The source upload must be completed and the resulting commit independently verified before claiming that the repository contains all artifacts.

## Verification commands

Requires Node.js 20 or newer:

```sh
npm test
npm run check
npm run demo
npm run client:demo
```

## Reports

- `CONTINUITY_RECOVERY.md` — recovery provenance and limitations.
- `AUDIT_CONTINUIDADE_ZION_V0.33.32.md` — continuity audit and local test evidence.
- `AUDIT_BACKUP_ZION_V0.33.32_DEEP.md` — deeper archive integrity and completeness audit.

Zion is an early research prototype. Review `SECURITY.md` before considering any deployment. The license notice in the recovered source tree says the complete official AGPL-3.0-only text must be added before the first public release.

---

## Audit and archive integrity update (2026-10-10)

A locally materialized preservation ZIP was checked: `zion-master-preservation-v0.33.32.zip`, 13,858,755 bytes, 388 archive entries verified, 0 missing and 0 mismatches. Calculated SHA-256 for that copy: `e0d7ae6ac2ed68f4dda1f975204df360be6c68ca79be4a86829d25430311f74a`.

**Checksum warning:** the older sidecar file in the recovered Library records `bdc15940baa23909775932bb0ae333693679cba12a650f890439879067dc332a`, which does not match the ZIP copy verified during this audit. Treat that sidecar as stale and use the recalculated hash above for that copy.

The recovery notes record 533 passing tests, syntax checks across 166 JavaScript files, successful demos, 26 preserved release ZIPs, 23 audit reports and 56 logs. These are recorded test results, not independent certification.

**Publication limit:** this README update and audit record do not upload the complete ZIP or source tree. Do not call this a complete source publication until the binary archive/source files are uploaded and verified in GitHub.
