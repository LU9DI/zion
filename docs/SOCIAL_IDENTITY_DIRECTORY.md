# Zion social identity directory (experimental)

`SocialIdentityDirectory` stores public profile bindings locally. A profile is registered with a proof-of-possession signature made by its Ed25519 signing key. Its stable identifier is `zion:` plus the SHA-256 fingerprint of the DER-encoded signing public key. The profile binds that signing key to an X25519 encryption public key.

## Example

```js
import { generateSocialIdentityKeys } from '../src/social-message-protocol.js';
import { createSocialIdentityRegistration, SocialIdentityDirectory } from '../src/social-identity-directory.js';

const keys = generateSocialIdentityKeys();
const registration = createSocialIdentityRegistration({
  username: 'alice_1',
  signingPrivateKeyPem: keys.signingPrivateKeyPem,
  signingPublicKeyPem: keys.signingPublicKeyPem,
  encryptionPublicKeyPem: keys.encryptionPublicKeyPem,
});
const directory = new SocialIdentityDirectory({ filePath: './data/social-profiles.json' });
await directory.register(registration);
const profile = await directory.getById(registration.identityId);
```

## Security boundaries

- A successful proof proves possession of the signing private key at registration time. It does **not** prove a real-world identity, uniqueness of a human, or immunity to Sybil attacks.
- The directory is local and has no distributed consensus or replication. Different nodes can hold different directories.
- Key rotation, revocation, recovery, account/device linking, spam policy, and trust bootstrap are not implemented.
- Protect the private key outside this directory. The JSON file contains public keys and proof only; it is not encrypted and should still be stored with appropriate filesystem permissions and backups.
- The current registration proof has a short freshness window for new registrations; existing records are validated cryptographically on restart without being rejected merely for age.
