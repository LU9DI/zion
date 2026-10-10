# Zion Social Message Node — v0.32.32

This module adds a small HTTP adapter around the durable encrypted-message inbox. It is an integration boundary for tests and controlled deployments, not the final decentralized transport.

## Endpoints

- `GET /api/v1/health` — minimal liveness response; exposes no inbox data.
- `POST /api/v1/messages` — accepts a signed encrypted envelope after sender and recipient authorization and signature verification.
- `GET /api/v1/inbox?recipient=<id>&limit=100&after=0` — retrieves queued envelopes only when the recipient authorization callback approves access.
- `POST /api/v1/inbox/ack` — removes queue entries for an authorized recipient after the client confirms it has safely accepted them.

All non-health routes require `Authorization: Bearer <secret>`. The secret must contain at least 32 bytes and is compared in constant time. Request bodies are capped at 128 KiB; the adapter applies a per-source-IP request limit. The underlying inbox imposes additional message, recipient, storage and TTL quotas.

## Integration example

```js
import { SocialMessageNode } from './src/social-message-node.js';

const node = new SocialMessageNode({
  filePath: './data/social-inbox.json',
  bearerToken: process.env.ZION_SOCIAL_BEARER_TOKEN,
  host: '127.0.0.1', // keep loopback unless protected by a proper deployment edge
  port: 4180,
  authorizeSender: async ({ senderId }) => identityDirectory.isTrustedSender(senderId),
  authorizeRecipient: async ({ recipientId }) => identityDirectory.canReceive(recipientId),
});
await node.listen();
```

The example's `identityDirectory` is an application-provided service; this repository does not supply a production identity directory. The callbacks intentionally default to deny. Do not replace them with unconditional `true` in a public deployment.

## Security boundary and limitations

- A bearer token is a deployment gate, not proof of a sender's cryptographic identity. The callbacks must bind IDs to trusted identities and authorization policy.
- The message signature is verified before queuing. The server does not decrypt the message body.
- Use TLS for any network traffic outside loopback. Do not expose this HTTP adapter directly to the public internet without TLS, key rotation, operational monitoring, abuse controls and an independently reviewed deployment configuration.
- This is not yet a native libp2p transport, DHT-routed delivery, offline peer discovery, push notification service, or multi-device synchronization protocol.
- Queue acknowledgement means the authorized client accepted the queued item; it does not mean the human recipient read the message. Read receipts need a separate authenticated protocol.
- The rate limiter is in-process and keyed by source IP. It is not a distributed abuse defense.
- No independent security audit has been performed.


### Confirmação de recebimento assinada (v0.32.33)

O endpoint `POST /api/v1/inbox/ack` exige agora um recibo assinado pela chave Ed25519 confiável do destinatário. Gere-o com `createSocialMessageAcknowledgement` e configure `verifyAcknowledgement` no nó para validar a assinatura contra a chave pública já vinculada ao perfil. Recibos sem assinatura, expirados, com IDs duplicados ou alterados são recusados. O callback de verificação deve resolver a chave a partir de uma fonte de identidade confiável; nunca confie em uma chave pública enviada pelo próprio pedido.

### Diretório de identidades (v0.32.35)

Quando `identityDirectory` é fornecido ao `SocialMessageNode`, o envio exige que `senderId` corresponda a um perfil registrado e que a chave de assinatura do envelope seja exatamente a chave pública desse perfil. O destinatário também precisa existir no diretório, e recibos são verificados contra a chave pública registrada. Consultas públicas de perfil ficam disponíveis em `GET /api/v1/profiles?username=...`, `GET /api/v1/profiles?limit=...&after=...` e `GET /api/v1/profiles/zion:<sha256>`.

**Importante:** `GET /api/v1/inbox` requer `authorizeInboxAccess` explícito quando o diretório é ativado. O token bearer do nó é um portão de serviço compartilhado e não substitui autenticação individual do destinatário. A callback deve verificar uma prova individual (por exemplo, assinatura de um desafio de curta duração vinculado a método, destinatário, timestamp e nonce); não a implemente apenas comparando um ID informado pelo cliente. Se a callback não for configurada, a leitura da caixa de entrada é recusada. O diretório é local e não resolve identidade global, Sybil, revogação, rotação ou recuperação de chaves.
