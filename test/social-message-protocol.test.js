import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decryptSocialMessage, encryptSocialMessage, generateSocialIdentityKeys, SocialMessageReplayGuard,
} from '../src/social-message-protocol.js';

function pair() {
  return { sender: generateSocialIdentityKeys(), recipient: generateSocialIdentityKeys() };
}
function message(sender, recipient, extra = {}) {
  return encryptSocialMessage({
    senderId: 'alice', recipientId: 'bob', plaintext: 'Olá, mensagem privada 👋',
    senderSigningPrivateKeyPem: sender.signingPrivateKeyPem,
    senderSigningPublicKeyPem: sender.signingPublicKeyPem,
    recipientEncryptionPublicKeyPem: recipient.encryptionPublicKeyPem,
    id: 'msg-001', createdAt: 1000, ...extra,
  });
}

test('encrypted message round-trips and exposes no plaintext', () => {
  const { sender, recipient } = pair();
  const envelope = message(sender, recipient);
  assert.equal(decryptSocialMessage({ envelope, recipientId: 'bob', recipientEncryptionPrivateKeyPem: recipient.encryptionPrivateKeyPem, trustedSenderSigningPublicKeyPem: sender.signingPublicKeyPem }), 'Olá, mensagem privada 👋');
  assert.equal(JSON.stringify(envelope).includes('Olá, mensagem privada'), false);
  assert.equal(envelope.version, 1);
});

test('message is bound to intended recipient', () => {
  const { sender, recipient } = pair();
  assert.throws(() => decryptSocialMessage({ envelope: message(sender, recipient), recipientId: 'mallory', recipientEncryptionPrivateKeyPem: recipient.encryptionPrivateKeyPem }), /different recipient/);
});

test('altered routing metadata or ciphertext is rejected', () => {
  const { sender, recipient } = pair();
  const original = message(sender, recipient);
  assert.throws(() => decryptSocialMessage({ envelope: { ...original, recipientId: 'mallory' }, recipientId: 'mallory', recipientEncryptionPrivateKeyPem: recipient.encryptionPrivateKeyPem }), /Invalid sender signature/);
  assert.throws(() => decryptSocialMessage({ envelope: { ...original, ciphertext: Buffer.from('alterado').toString('base64') }, recipientId: 'bob', recipientEncryptionPrivateKeyPem: recipient.encryptionPrivateKeyPem }), /Invalid sender signature/);
});

test('sender key must match a trusted profile key when supplied', () => {
  const { sender, recipient } = pair();
  const other = generateSocialIdentityKeys();
  assert.throws(() => decryptSocialMessage({ envelope: message(sender, recipient), recipientId: 'bob', recipientEncryptionPrivateKeyPem: recipient.encryptionPrivateKeyPem, trustedSenderSigningPublicKeyPem: other.signingPublicKeyPem }), /trusted profile key/);
});

test('rejects oversized plaintext and invalid identifiers', () => {
  const { sender, recipient } = pair();
  assert.throws(() => message(sender, recipient, { plaintext: 'x'.repeat(65 * 1024) }), /at most/);
  assert.throws(() => encryptSocialMessage({ senderId: '', recipientId: 'bob', plaintext: 'x', senderSigningPrivateKeyPem: sender.signingPrivateKeyPem, senderSigningPublicKeyPem: sender.signingPublicKeyPem, recipientEncryptionPublicKeyPem: recipient.encryptionPublicKeyPem }), /senderId/);
});

test('replay guard rejects duplicate sender/message IDs and bounds memory', () => {
  let now = 10;
  const guard = new SocialMessageReplayGuard({ maxEntries: 2, ttlMs: 20, now: () => now });
  assert.equal(guard.accept({ senderId: 'alice', id: '1' }), true);
  assert.equal(guard.accept({ senderId: 'alice', id: '1' }), false);
  assert.equal(guard.accept({ senderId: 'bob', id: '1' }), true);
  assert.equal(guard.accept({ senderId: 'carol', id: '1' }), true);
  assert.equal(guard.size, 2);
  now = 40;
  assert.equal(guard.accept({ senderId: 'alice', id: '1' }), true);
});
