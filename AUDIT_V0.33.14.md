# Zion v0.33.14 — Witness recovery boundaries and request policy

## Scope

This release extends the remote Witness client regression suite. It focuses on conservative recovery around temporary publication files, cryptographic signature rejection, and explicit HTTP request policy.

## Added regressions

- **Orphan temporary file:** when the destination does not exist, a valid response can be committed atomically; an unrelated orphaned `.tmp` file is preserved rather than deleted based on a guessed ownership rule.
- **Invalid signature:** a structurally valid response signed by an unrelated Ed25519 key is rejected and no evidence destination is created.
- **Request policy:** the client passes `redirect: 'error'` and an `AbortSignal` deadline to the fetch implementation.

## Reproduction

Requirements: Node.js 20 or later.

```sh
npm test
npm run check
npm run demo
unzip -t zion-v0.33.14-witness-recovery-boundaries.zip
sha256sum -c zion-v0.33.14-witness-recovery-boundaries.zip.sha256
```

## Limits

- These tests use local fixtures and deterministic injected fetch implementations; they do not establish behavior under arbitrary operating-system crashes, power loss, faulty storage, or all filesystem semantics.
- TLS tests in the preceding release cover a trusted local test CA, hostname mismatch, and an untrusted CA. Expired-certificate coverage remains outstanding.
- No GitHub publication or production deployment is claimed by this package.
