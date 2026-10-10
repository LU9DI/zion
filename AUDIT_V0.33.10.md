# Zion v0.33.10 — Witness client fail-closed transport audit

## Scope

This release adds deterministic regression tests around the remote Witness client when transport or response delivery fails. The tests use an injected `fetchImpl` so the failure modes are repeatable and do not depend on external networks.

## New regression cases

- Network interruption / rejected fetch promise.
- HTTP 503 response.
- Successful HTTP status with a non-JSON content type.
- Truncated/invalid JSON body.
- Response body larger than the 16 KiB ceiling.

For each case, the client must reject the operation and leave the evidence output path nonexistent. Existing end-to-end tests still cover a valid live challenge and verification of the saved signed evidence.

## Reproduction

Requirements: Node.js 20 or later.

```sh
npm test
npm run check
npm run demo
unzip -t zion-v0.33.10-witness-client-fail-closed.zip
sha256sum -c zion-v0.33.10-witness-client-fail-closed.zip.sha256
```

## Observed local results

- `npm test`: **454 passed, 0 failed** (449 existing tests plus 5 new cases).
- Syntax check and demo results are recorded from the release build validation.
- The new tests establish that the listed injected failures do not create an evidence file.

## Limits

This is not a live TLS certificate-chain/hostname test and does not prove all socket interruptions, DNS behavior, reverse-proxy behavior, filesystem crash semantics, or production deployment safety. HTTPS certificate verification remains delegated to Node.js's standard fetch/TLS stack. No GitHub publication or production deployment is claimed.
