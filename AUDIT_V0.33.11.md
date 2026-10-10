# Zion v0.33.11 — Witness evidence commit audit

## Scope

This release adds three deterministic client regression tests focused on interrupted response bodies and evidence output ownership.

## New regression cases

- A successful HTTP response whose body stream fails during read must not create evidence.
- A valid signed witness response cannot overwrite a pre-existing evidence file.
- Two concurrent valid responses targeting the same output path produce exactly one successful commit; the losing operation must fail rather than overwrite the winner.

The tests use an Ed25519 key pair generated locally and injected `fetchImpl` responses. They do not contact external services.

## Reproduction

Requirements: Node.js 20 or later.

```sh
npm test
npm run check
npm run demo
unzip -t zion-v0.33.11-witness-evidence-commit-hardening.zip
sha256sum -c zion-v0.33.11-witness-evidence-commit-hardening.zip.sha256
```

## Observed local results

- `npm test`: **457 passed, 0 failed** (454 previous tests plus 3 new regressions).
- `npm run check`: passed for 141 JavaScript files.
- `npm run demo`: exited successfully; busy-host and unavailable-telemetry cases produced zero work budgets.

## Limits

These tests establish client-level exclusive-create behavior in the local test environment. They do not prove universal crash consistency, distributed filesystem semantics, live TLS certificate-chain validation, or production deployment safety. No GitHub publication or production deployment is claimed.
