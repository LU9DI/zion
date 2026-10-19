# Security policy

Zion is under active development (pre-1.0) and has not yet had an independent security audit. Until a stable release is announced, do not use it as the sole copy of important data or for highly sensitive data.

For responsible disclosure, use the repository's Security tab and submit a private vulnerability report if that feature is enabled. Do not publish exploit details in a public issue before coordinating remediation. If private reporting is unavailable, contact the repository maintainer through GitHub to arrange a private disclosure channel.

### Remote freshness challenges

Challenge responses are Ed25519 signed and bind a fresh 256-bit random nonce, challenge validity window, witness identity/key ID, sequence, and exact checkpoint-history head. The verifier must obtain the witness public key independently and compare the response nonce to the nonce it just issued. Reusing a nonce weakens replay resistance. The current implementation verifies response files and does not provide network transport, persistent anti-rollback storage, or a remotely operated witness service; deployments must not claim full rollback resistance on this basis alone.
