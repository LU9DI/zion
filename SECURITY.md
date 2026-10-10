# Security policy

This is an early research prototype and is not suitable for production or sole-copy storage. Please do not upload sensitive data to experimental nodes.

For responsible disclosure, open a private security advisory in the GitHub repository once it exists. Until a repository is published, no official security-reporting channel is configured.

### Remote freshness challenges

Challenge responses are Ed25519 signed and bind a fresh 256-bit random nonce, challenge validity window, witness identity/key ID, sequence, and exact checkpoint-history head. The verifier must obtain the witness public key independently and compare the response nonce to the nonce it just issued. Reusing a nonce weakens replay resistance. The current implementation verifies response files and does not provide network transport, persistent anti-rollback storage, or a remotely operated witness service; deployments must not claim full rollback resistance on this basis alone.
