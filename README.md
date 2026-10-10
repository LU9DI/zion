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