# Agent guidance — Zion

Zion is a Rust workspace with a separate rust-core crate, alongside supporting Node.js code and security-sensitive peer/network behavior.

## Skill routing
- Rust memory safety, concurrency, parsing, resource limits, or cryptographic boundaries: read .agents/skills/rust-security-review/SKILL.md.
- Peer identity, handshakes, replay protection, message parsing, network failures, or wire protocol changes: read .agents/skills/p2p-protocol-testing/SKILL.md.

## Validation
Inspect workspace and crate-level instructions before changes. Run cargo fmt --check, cargo clippy, and cargo test for affected crates; run Node checks only for changed JS/TS packages. Do not infer production security from passing unit tests alone.
