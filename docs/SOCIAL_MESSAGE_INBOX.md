# Zion social message inbox — experimental storage primitive

`SocialMessageInbox` persists opaque, encrypted message envelopes in a local JSON store. It provides bounded queues per recipient, a global message/byte quota, expiry, idempotent enqueue by `(senderId, messageId)`, polling, and explicit acknowledgement. The store is intended as a transport adapter primitive, not as a complete messaging service.

## Security boundary

- The inbox stores the envelope as received; it does not decrypt it or independently verify the sender's Ed25519 signature.
- A sender ID in an envelope is not authentication. A network-facing adapter MUST authenticate the connecting peer, verify the envelope signature against a trusted profile/key binding, enforce authorization/rate limits, and ensure the caller may poll/acknowledge only their own recipient ID.
- This module is not exposed as an HTTP endpoint and does not itself deliver messages between machines. It is not safe to expose its data file or wrap it in an unauthenticated public API.
- The JSON file contains ciphertext envelopes and routing metadata. It does not contain plaintext from the message body, but metadata such as sender, recipient, timestamp, and message size remains visible. Filesystem access and backups still require protection.
- Atomic replacement reduces partial writes but is not a database transaction or a guarantee against disk/controller failure. A production implementation should use a transactional database and durable fsync semantics appropriate to its threat model.
- Expiry uses the local system clock; clock rollback and hostile timestamp policy must be handled at the authenticated transport boundary.

## API

```js
import { SocialMessageInbox } from './src/social-message-inbox.js';

const inbox = await new SocialMessageInbox({
  filePath: './.zion-data/social-inbox.json',
  maxMessages: 10_000,
  maxPerRecipient: 500,
}).init();

await inbox.enqueue(encryptedEnvelope);
const pending = await inbox.list('recipient-profile-id', { limit: 100 });
await inbox.acknowledge('recipient-profile-id', pending.map(item => item.queueId));
```

Acknowledgement removes queue entries; callers should acknowledge only after they have durably recorded the message and verified its signature/authentication tag. A lost acknowledgement can cause redelivery, so consumers must remain idempotent.
