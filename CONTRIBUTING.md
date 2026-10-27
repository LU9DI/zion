# Contributing

Zion is being engineered toward production-grade decentralized storage. Contributions must improve the implementation without overstating what is deployed or validated.

## Security and resource-safety invariants

- Preserve owner-first resource safety. Never silently raise owner-configured CPU, memory, disk, bandwidth, concurrency, power, or thermal limits.
- Fail closed when required security configuration, trusted identity material, authorization, integrity checks, or safety telemetry is missing or invalid.
- Do not treat node identity, a signature, a hash, a receipt, or a local `fsync` as proof of authorization, remote availability, or physical durability.
- Keep plaintext and file keys on the client side unless a documented protocol explicitly requires otherwise. Never put content keys in manifests or logs.
- Do not enable public listeners, plaintext remote transport, or unsafe fallback behavior to make a demo pass.
- Do not add blockchain, tokens, remote code execution, or mandatory hosted services without a documented design review and explicit approval.
- Never implement cryptographic primitives from scratch. Use established libraries and documented, reviewed protocols.

## Tests and validation

- Add tests for normal behavior, hostile and malformed inputs, missing or stale telemetry, authorization failures, replay, resource exhaustion, concurrency, and failure/crash recovery as relevant.
- Test fail-closed behavior, not only the successful path. Include negative tests for untrusted certificates, malformed identities, invalid signatures, duplicate/replayed messages, and exceeded limits where applicable.
- Keep tests deterministic and bounded. Do not rely on external production services or secrets in CI.
- Run `npm ci`, `npm run check`, `npm test`, and the relevant Rust checks (including `cargo test --locked`) for changes touching those areas. Report the exact commands and outcomes; do not claim tests ran if they did not.
- Treat CI success as evidence for the checks and commit actually tested—not as an independent security audit or production-readiness certification.

## Architecture and documentation

- Do not describe local simulation, loopback tests, injected adapters, demo data, or a successful unit test as a live decentralized network or production capability.
- Update `README.md`, `SECURITY.md`, `docs/THREAT_MODEL.md`, and relevant architecture/audit documentation whenever a change alters capabilities, trust boundaries, limitations, or release gates.
- Record design decisions for protocol changes, key lifecycle, peer trust, storage durability, resource enforcement, or distributed abuse resistance before implementation.
- Do not remove or weaken a documented production gate merely to make the project appear ready. A gate may be closed only with implementation evidence, relevant tests, and deployment-level verification.
