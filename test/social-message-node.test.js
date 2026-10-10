import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialMessageNode } from '../src/social-message-node.js';
import { createSocialMessageAcknowledgement, encryptSocialMessage, generateSocialIdentityKeys, verifySocialMessageAcknowledgement } from '../src/social-message-protocol.js';

const token = 'test-token-that-is-at-least-thirty-two-bytes-long';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zion-social-node-'));
  const alice = generateSocialIdentityKeys();
  const bob = generateSocialIdentityKeys();
  const node = new SocialMessageNode({
    filePath: join(dir, 'inbox.json'), bearerToken: token,
    authorizeSender: async ({ senderId }) => senderId === 'alice',
    authorizeRecipient: async ({ recipientId }) => recipientId === 'bob',
    verifyAcknowledgement: ack => verifySocialMessageAcknowledgement(ack, { trustedRecipientSigningPublicKeyPem: bob.signingPublicKeyPem }),
    ...options,
  });
  const address = await node.listen();
  t.after(async () => { await node.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const message = encryptSocialMessage({
    senderId: 'alice', recipientId: 'bob', plaintext: 'hello over Zion',
    senderSigningPrivateKeyPem: alice.signingPrivateKeyPem,
    senderSigningPublicKeyPem: alice.signingPublicKeyPem,
    recipientEncryptionPublicKeyPem: bob.encryptionPublicKeyPem,
  });
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  return { request, message, bob, bobIdentity: bob };
}

test('social message node delivers signed encrypted envelopes to the authorized recipient and acknowledges them', async t => {
  const { request, message, bobIdentity } = await fixture(t);
  const sent = await request('/api/v1/messages', { method: 'POST', body: JSON.stringify(message) });
  assert.equal(sent.status, 202);
  assert.equal((await sent.json()).accepted, true);
  const inbox = await request('/api/v1/inbox?recipient=bob');
  assert.equal(inbox.status, 200);
  const payload = await inbox.json();
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].envelope.id, message.id);
  const ackBody = createSocialMessageAcknowledgement({ recipientId: 'bob', queueIds: [payload.messages[0].queueId], recipientSigningPrivateKeyPem: bobIdentity.signingPrivateKeyPem });
  const ack = await request('/api/v1/inbox/ack', { method: 'POST', body: JSON.stringify(ackBody) });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).acknowledged, 1);
});

test('social message node rejects requests without a bearer token', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/v1/inbox?recipient=bob', { headers: { authorization: '' } });
  assert.equal(response.status, 401);
});

test('social message node rejects untrusted senders and recipients', async t => {
  const { request, message } = await fixture(t);
  const senderDenied = await request('/api/v1/messages', { method: 'POST', body: JSON.stringify({ ...message, senderId: 'mallory' }) });
  assert.equal(senderDenied.status, 403);
  const recipientDenied = await request('/api/v1/inbox?recipient=alice');
  assert.equal(recipientDenied.status, 403);
});

test('social message node rejects a tampered signed envelope', async t => {
  const { request, message } = await fixture(t);
  const response = await request('/api/v1/messages', { method: 'POST', body: JSON.stringify({ ...message, recipientId: 'mallory' }) });
  assert.equal(response.status, 403); // Recipient authorization fails before signature processing.
  const tampered = { ...message, ciphertext: Buffer.from('tampered').toString('base64') };
  const badSignature = await request('/api/v1/messages', { method: 'POST', body: JSON.stringify(tampered) });
  assert.equal(badSignature.status, 400);
  assert.equal((await badSignature.json()).error, 'invalid_signature');
});

test('social message node exposes only a minimal health endpoint without private inbox data', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/v1/health', { headers: { authorization: '' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'zion-social-messages', protocol: 1 });
});

test('social message node rejects unsigned or tampered delivery acknowledgements', async t => {
  const { request, message, bobIdentity } = await fixture(t);
  await request('/api/v1/messages', { method: 'POST', body: JSON.stringify(message) });
  const inbox = await (await request('/api/v1/inbox?recipient=bob')).json();
  const queueId = inbox.messages[0].queueId;
  const unsigned = await request('/api/v1/inbox/ack', { method: 'POST', body: JSON.stringify({ recipientId: 'bob', queueIds: [queueId] }) });
  assert.equal(unsigned.status, 400);
  const signed = createSocialMessageAcknowledgement({ recipientId: 'bob', queueIds: [queueId], recipientSigningPrivateKeyPem: bobIdentity.signingPrivateKeyPem });
  const tampered = await request('/api/v1/inbox/ack', { method: 'POST', body: JSON.stringify({ ...signed, recipientId: 'mallory' }) });
  assert.equal(tampered.status, 403);
  const stillQueued = await (await request('/api/v1/inbox?recipient=bob')).json();
  assert.equal(stillQueued.messages.length, 1);
});

test('social node binds sender and recipient authorization to persistent directory identities', async t => {
  const { SocialIdentityDirectory, createSocialIdentityRegistration } = await import('../src/social-identity-directory.js');
  const dir = await mkdtemp(join(tmpdir(), 'zion-social-directory-node-'));
  const alice = generateSocialIdentityKeys();
  const bob = generateSocialIdentityKeys();
  const directory = new SocialIdentityDirectory({ filePath: join(dir, 'profiles.json') });
  const aliceRegistration = createSocialIdentityRegistration({ username: 'alice_node', signingPrivateKeyPem: alice.signingPrivateKeyPem, signingPublicKeyPem: alice.signingPublicKeyPem, encryptionPublicKeyPem: alice.encryptionPublicKeyPem });
  const bobRegistration = createSocialIdentityRegistration({ username: 'bob_node', signingPrivateKeyPem: bob.signingPrivateKeyPem, signingPublicKeyPem: bob.signingPublicKeyPem, encryptionPublicKeyPem: bob.encryptionPublicKeyPem });
  await directory.register(aliceRegistration);
  await directory.register(bobRegistration);
  const node = new SocialMessageNode({ filePath: join(dir, 'inbox.json'), bearerToken: token, identityDirectory: directory, authorizeInboxAccess: async ({ recipientId }) => recipientId === bobRegistration.identityId });
  const address = await node.listen();
  t.after(async () => { await node.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path, init = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  const publicProfile = await request(`/api/v1/profiles?username=alice_node`);
  assert.equal(publicProfile.status, 200);
  assert.equal((await publicProfile.json()).profile.identityId, aliceRegistration.identityId);
  const envelope = encryptSocialMessage({ senderId: aliceRegistration.identityId, recipientId: bobRegistration.identityId, plaintext: 'directory-bound hello', senderSigningPrivateKeyPem: alice.signingPrivateKeyPem, senderSigningPublicKeyPem: alice.signingPublicKeyPem, recipientEncryptionPublicKeyPem: bob.encryptionPublicKeyPem });
  const sent = await request('/api/v1/messages', { method: 'POST', body: JSON.stringify(envelope) });
  assert.equal(sent.status, 202);
  const inboxResponse = await request(`/api/v1/inbox?recipient=${encodeURIComponent(bobRegistration.identityId)}`);
  const inbox = await inboxResponse.json();
  assert.equal(inbox.messages.length, 1);
  const ack = createSocialMessageAcknowledgement({ recipientId: bobRegistration.identityId, queueIds: [inbox.messages[0].queueId], recipientSigningPrivateKeyPem: bob.signingPrivateKeyPem });
  const acknowledged = await request('/api/v1/inbox/ack', { method: 'POST', body: JSON.stringify(ack) });
  assert.equal(acknowledged.status, 200);
  const spoof = { ...envelope, id: 'another-message', senderId: bobRegistration.identityId };
  const rejected = await request('/api/v1/messages', { method: 'POST', body: JSON.stringify(spoof) });
  assert.equal(rejected.status, 403);
});

test('identity directory mode denies inbox reads unless per-recipient authorization is explicitly configured', async t => {
  const { SocialIdentityDirectory, createSocialIdentityRegistration } = await import('../src/social-identity-directory.js');
  const dir = await mkdtemp(join(tmpdir(), 'zion-social-inbox-auth-'));
  const bob = generateSocialIdentityKeys();
  const directory = new SocialIdentityDirectory({ filePath: join(dir, 'profiles.json') });
  const bobRegistration = createSocialIdentityRegistration({ username: 'bob_private', signingPrivateKeyPem: bob.signingPrivateKeyPem, signingPublicKeyPem: bob.signingPublicKeyPem, encryptionPublicKeyPem: bob.encryptionPublicKeyPem });
  await directory.register(bobRegistration);
  const node = new SocialMessageNode({ filePath: join(dir, 'inbox.json'), bearerToken: token, identityDirectory: directory });
  const address = await node.listen();
  t.after(async () => { await node.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/inbox?recipient=${encodeURIComponent(bobRegistration.identityId)}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 403);
});
