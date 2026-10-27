---
name: rust-security-review
description: Review Rust safety, concurrency, resource limits, and cryptographic boundary handling.
---
# Rust security review

- Read the module's invariants and ownership model before changing concurrency, state transitions, or unsafe code.
- Prefer safe Rust; every unsafe block must have a narrow scope, documented invariants, and tests for its assumptions.
- Validate lengths, integer conversions, allocation sizes, parsing boundaries, and untrusted peer input before use.
- Avoid panics on untrusted network input; return typed errors and preserve process availability.
- Review lock ordering, poisoning, cancellation, task shutdown, and backpressure to prevent deadlocks and resource exhaustion.
- Use constant-time and vetted cryptographic primitives where secrets are involved; do not implement novel cryptography.
- Test malformed frames, oversized messages, truncation, duplicate/replayed messages, concurrency, timeouts, and recovery.
- Run cargo fmt --check, cargo clippy, and cargo test for affected workspace crates when available.
