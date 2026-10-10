# Zion social session authentication (experimental)

Version: 0.32.36. This module provides challenge-response authentication for a registered social identity. It does not prove a civil identity, prevent Sybil registrations, or establish a globally authoritative directory.

## Flow

1. Register a profile in `SocialIdentityDirectory` with `createSocialIdentityRegistration`.
2. `POST /api/v1/auth/challenge` with `{ "identityId": "zion:<sha256>" }`.
3. Sign the returned challenge with `createSocialAuthenticationProof(challenge, signingPrivateKeyPem)`.
4. `POST /api/v1/auth/session` with that proof.
5. Send the returned token as `Authorization: Bearer <token>` for protected routes.

The challenge is one-time, bound to an identity, expires quickly, and is consumed even when a proof attempt fails. The session token is random and opaque; the authority stores only its SHA-256 digest. Sessions have a bounded lifetime, can be revoked by token, and are memory-only: restarting the process invalidates all sessions.

## HTTP behavior with sessionAuthority enabled

- `POST /api/v1/messages`: authenticated session identity must match `envelope.senderId`, and the envelope signing key must match the directory profile.
- `GET /api/v1/inbox?recipient=<identityId>`: the requested recipient must equal the authenticated session identity.
- `POST /api/v1/inbox/ack`: the acknowledgement recipient must equal the authenticated session identity and the receipt signature must verify against the directory key.
- The legacy shared bearer token is not accepted for protected routes while session mode is enabled.
- Public profile lookup and health endpoints remain public; do not expose the current server publicly without additional deployment controls.

## Example setup

```js
import { SocialIdentityDirectory } from './src/social-identity-directory.js';
import { SocialSessionAuthority } from './src/social-session-authority.js';
import { SocialMessageNode } from './src/social-message-node.js';

const directory = new SocialIdentityDirectory({ filePath: './data/profiles.json' });
await directory.init();
const sessions = new SocialSessionAuthority({ identityDirectory: directory });
const node = new SocialMessageNode({
  filePath: './data/inbox.json',
  bearerToken: process.env.ZION_LEGACY_GATE_TOKEN, // still required by constructor, not used for protected routes in session mode
  identityDirectory: directory,
  sessionAuthority: sessions,
});
await node.listen();
```

The `bearerToken` constructor argument remains required for backwards-compatible construction, even when session mode is active; generate a random secret of at least 32 bytes and do not hardcode a production secret. The session mode itself uses identity-bound tokens instead.

## Limits and remaining work

- No TLS, reverse-proxy policy, distributed rate limiting, device/session management UI, persistent sessions, refresh tokens, key rotation, or recovery.
- The authority is in-memory and local to one process; sessions do not synchronize across nodes.
- Public challenge endpoints have a global pending-challenge cap but need robust per-IP/per-identity abuse controls at deployment edge.
- The directory is local and does not resolve identity conflicts between independent nodes.
- This implementation is not independently audited and is not production-ready authentication.
