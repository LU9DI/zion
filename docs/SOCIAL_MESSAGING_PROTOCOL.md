# Zion social messaging protocol — experimental v1

`src/social-message-protocol.js` is a cryptographic building block for private messages. It is not a complete messaging service and does not itself deliver, store, synchronize, or acknowledge messages across peers.

## Envelope

1. Sender identity has separate Ed25519 signing and X25519 encryption key pairs.
2. For each message, the sender generates an ephemeral X25519 key pair and derives a shared secret with the recipient's X25519 public key.
3. HKDF-SHA-256 derives an AES-256-GCM key using the message salt and protocol-specific context.
4. AES-256-GCM encrypts UTF-8 plaintext and authenticates routing metadata (`version`, message ID, sender ID, recipient ID) as associated data.
5. The sender signs the canonical envelope using Ed25519. The recipient verifies the signature before decrypting.
6. The receiver can provide a trusted signing public key from a separately verified profile. Without that check, the signature proves possession of the private key corresponding to the key embedded in the envelope, not that the key truly belongs to the claimed username.
7. `SocialMessageReplayGuard` offers a bounded, in-memory duplicate filter. It is not durable and must not be treated as persistent anti-replay protection across restarts.

## Current limits and security status

- Maximum plaintext: 64 KiB per message.
- Key management, secure backup/recovery, key rotation/revocation, identity registration, profile-key binding, durable replay state, delivery receipts, offline queues, synchronization, and P2P transport are not implemented here.
- No ratchet or group messaging is implemented. This is not a claim of forward secrecy for stored conversation history: compromise of the recipient's long-term encryption key can expose recorded envelopes addressed to that key.
- JavaScript strings and private-key objects cannot be reliably zeroized by this module. Protect the process and key storage.
- The code has regression tests but has not undergone independent cryptographic review. Do not use it as a production security guarantee or expose it as a public messaging service yet.
- Canonical serialization is defined for the JSON-compatible values emitted by this module. A cross-language implementation needs published test vectors and stricter wire-format conformance before interoperability.

## Tests

Run `node --test test/social-message-protocol.test.js` and `npm test` from the repository root.

## Next required integration steps

1. Establish and verify user identity/profile keys.
2. Define a versioned, canonical wire format and cross-implementation test vectors.
3. Add authenticated peer transport and a bounded offline mailbox/queue with explicit retention policy.
4. Persist replay protection and delivery state transactionally.
5. Add block/report/rate-limit controls and protect against spam, key substitution, replay, metadata leakage, and denial of service.
6. Commission independent protocol and implementation review before public release.
