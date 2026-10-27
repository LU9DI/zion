# Security policy

Zion is being engineered as a production-grade decentralized storage and peer-to-peer cloud platform. Production is the project objective, but readiness is specific to a release and deployment and must be demonstrated. Passing CI or local tests alone is not a security certification.

## Safe operating boundary

The current repository documents material gaps, including the absence of a validated live libp2p/Kademlia network, incomplete production certificate lifecycle and key management, incomplete distributed Sybil/DDoS defenses, incomplete OS-enforced resource quotas, and storage/replication paths that are not fully integrated into node bootstrap. The cloud UI is a preview rather than a connected cloud service.

Until the relevant release gates are implemented, tested, independently reviewed, and verified for the intended deployment:

- Do not expose experimental peer transport directly to the public internet.
- Do not use the current implementation to store sensitive data or the only copy of important files.
- Do not treat the in-memory storage adapter as durable storage.
- Do not treat signed receipts, hashes, local signatures, or `fsync` calls as independent proof of remote persistence or physical durability.
- Do not claim production readiness based solely on a passing CI run.

Consult [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [AUDIT_CURRENT_ZION.md](AUDIT_CURRENT_ZION.md) for current trust boundaries and known blockers. Update those documents when implementation or validation changes materially.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's GitHub Security tab if private vulnerability reporting is enabled. Do not publish exploit details, credentials, private keys, or sensitive user data in a public issue. If private reporting is unavailable, contact the repository maintainer through GitHub to arrange a private disclosure channel.

A useful report includes the affected commit/version, impacted component, prerequisites, reproducible steps or a minimal proof of concept, expected versus actual behavior, and potential impact. Redact secrets and avoid testing against systems or data you do not own or have permission to assess. Please allow time for triage and coordinated remediation before public disclosure.

## Security-relevant implementation notes

### Peer transport

Remote connections require configured mutual TLS material; plaintext transport is restricted to loopback. CI tests using ephemeral certificates do not establish that production certificate issuance, rotation, revocation, trust distribution, and independent-host interoperability are operational. Do not weaken fail-closed behavior to make an integration test or demo succeed.

### Witness freshness and recovery

Challenge responses are Ed25519-signed and bind a fresh random nonce, validity window, witness identity/key ID, sequence, and checkpoint-history head. The verifier must obtain the witness public key independently and compare the response nonce with the nonce it issued. Reusing a nonce weakens replay resistance. File-based verification does not itself provide network transport, persistent anti-rollback storage, or a remotely operated witness authority; do not claim full rollback resistance on this basis alone.

## Response and disclosure

Security reports should be triaged, reproduced safely, and linked to a fix and regression test where possible. Public advisories should describe affected versions, impact, mitigations, and fixed versions without exposing unnecessary exploit detail or secrets.
