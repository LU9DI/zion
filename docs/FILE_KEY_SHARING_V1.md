# Zion file-key sharing v1

This increment adds an end-to-end key envelope for sharing one file key with one authorized recipient device. It does not change storage behavior and does not publish the plaintext file key to a storage peer.

## Flow

1. The recipient generates an X25519 key pair with `generateFileKeyRecipientIdentity()`.
2. The recipient securely delivers `publicKeyPem` to the sender and proves/establishes its association with the intended user through an independently trusted channel.
3. The sender calls `createFileKeyEnvelope(senderIdentity, recipientPublicKeyPem, { cid, fileKey })`.
4. The sender transmits the signed envelope to the recipient.
5. The recipient calls `openFileKeyEnvelope(envelope, privateKeyPem, { expectedCid, expectedSenderNodeId })`, verifies the sender signature and recipient binding, then unwraps the file key.

## Cryptographic construction

- Ephemeral X25519 Diffie–Hellman creates a shared secret for each envelope.
- HKDF-SHA-256 derives a one-time wrapping key using a fresh 32-byte salt.
- AES-256-GCM encrypts the 32-byte file key with a fresh 12-byte nonce.
- The complete envelope payload is signed by the sender's Ed25519 node identity.
- The associated authenticated data binds the content identifier, recipient key fingerprint, protocol and sender identity.
- Historical envelopes remain signature-verifiable offline; expected sender authorization must come from a trusted identity directory or another authenticated channel.

## Example

```js
import { createNodeIdentity } from '../src/peer-security.js';
import {
  generateFileKeyRecipientIdentity,
  createFileKeyEnvelope,
  openFileKeyEnvelope,
} from '../src/file-key-sharing.js';

const sender = createNodeIdentity();
const recipient = generateFileKeyRecipientIdentity();
const envelope = createFileKeyEnvelope(sender, recipient.publicKeyPem, {
  cid: stored.cid,
  fileKey: stored.fileKey,
});

const opened = openFileKeyEnvelope(envelope, recipient.privateKeyPem, {
  expectedCid: stored.cid,
  expectedSenderNodeId: sender.nodeId,
});
// Use opened.fileKey with the decrypting client, then clear it when finished.
opened.fileKey.fill(0);
```

## Security boundary and remaining work

- Protect recipient private keys with the operating system's secure key store or an equivalent hardened vault. The returned PEM is not encrypted at rest by this helper.
- Authenticate the mapping between a user/device and its public key. A valid signature does not itself authorize a sender.
- This increment does not provide threshold recovery, Shamir Secret Sharing, revocation of already-shared keys, automatic rewrapping on rotation, multi-recipient policy management, or key backup.
- Revoking a recipient cannot make that recipient forget a key already received. To revoke future access, rotate the file key and re-encrypt/re-share the content under the new key.
- JavaScript cannot guarantee reliable zeroization of every internal copy made by the runtime. The helper clears its owned temporary buffers where practical; callers must minimize key lifetime and avoid logs.
- This is a cryptographic building block, not a completed production key-management system. It needs independent review and integration tests before production use.
