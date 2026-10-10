import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialIdentityDirectory, createSocialIdentityRegistration } from '../src/social-identity-directory.js';
import { SocialSessionAuthority, createSocialAuthenticationProof } from '../src/social-session-authority.js';
import { SocialMessageNode } from '../src/social-message-node.js';
import { createSocialMessageAcknowledgement, encryptSocialMessage, generateSocialIdentityKeys } from '../src/social-message-protocol.js';

async function fixture(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zion-social-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = new SocialIdentityDirectory({ filePath: join(dir, 'profiles.json') });
  const aliceKeys = generateSocialIdentityKeys(); const bobKeys = generateSocialIdentityKeys();
  const alice = createSocialIdentityRegistration({ username: 'alice_auth', ...aliceKeys });
  const bob = createSocialIdentityRegistration({ username: 'bob_auth', ...bobKeys });
  await directory.register(alice); await directory.register(bob);
  const authority = new SocialSessionAuthority({ identityDirectory: directory, ...opts });
  return { dir, directory, authority, alice, bob, aliceKeys, bobKeys };
}
async function login(authority, profile, keys) {
  const challenge = await authority.issueChallenge(profile.identityId);
  const proof = createSocialAuthenticationProof(challenge, keys.signingPrivateKeyPem);
  return authority.createSession(proof);
}

test('challenge proof creates an identity-bound session without retaining the raw token', async t => {
  const f = await fixture(t);
  const session = await login(f.authority, f.alice, f.aliceKeys);
  assert.equal(session.identityId, f.alice.identityId);
  assert.equal(session.tokenType, 'Bearer');
  assert.equal(f.authority.authenticateToken(session.token).identityId, f.alice.identityId);
  assert.equal(f.authority.authenticateToken('not-a-valid-token'), null);
});

test('authentication challenges are one-time and wrong-key proof fails', async t => {
  const f = await fixture(t);
  const challenge = await f.authority.issueChallenge(f.alice.identityId);
  const wrong = createSocialAuthenticationProof(challenge, f.bobKeys.signingPrivateKeyPem);
  await assert.rejects(f.authority.createSession(wrong), /invalid_or_expired_challenge/);
  const right = createSocialAuthenticationProof(challenge, f.aliceKeys.signingPrivateKeyPem);
  await assert.rejects(f.authority.createSession(right), /invalid_or_expired_challenge/);
});

test('a new challenge invalidates an earlier challenge for the same identity', async t => {
  const f = await fixture(t);
  const oldChallenge = await f.authority.issueChallenge(f.alice.identityId);
  await f.authority.issueChallenge(f.alice.identityId);
  await assert.rejects(f.authority.createSession(createSocialAuthenticationProof(oldChallenge, f.aliceKeys.signingPrivateKeyPem)), /invalid_or_expired_challenge/);
});

test('expired sessions cannot authenticate and tokens can be revoked', async t => {
  let now = 1_800_000_000_000;
  const f = await fixture(t, { now: () => now, sessionTtlMs: 60_000 });
  const session = await login(f.authority, f.alice, f.aliceKeys);
  assert.ok(f.authority.authenticateToken(session.token));
  assert.equal(f.authority.revokeToken(session.token), true);
  assert.equal(f.authority.authenticateToken(session.token), null);
  const second = await login(f.authority, f.alice, f.aliceKeys);
  now += 61_000;
  assert.equal(f.authority.authenticateToken(second.token), null);
});

test('challenge requests reject unknown identities and expire under injected clock', async t => {
  let now = 1_800_000_000_000;
  const f = await fixture(t, { now: () => now, challengeTtlMs: 5_000 });
  await assert.rejects(f.authority.issueChallenge('zion:unknown'), /identity_not_found/);
  const challenge = await f.authority.issueChallenge(f.alice.identityId);
  now += 6_000;
  await assert.rejects(f.authority.createSession(createSocialAuthenticationProof(challenge, f.aliceKeys.signingPrivateKeyPem)), /invalid_or_expired_challenge/);
});

test('HTTP node binds message sending, inbox reads, and acknowledgements to individual sessions', async t => {
  const f = await fixture(t);
  const node = new SocialMessageNode({ filePath: join(f.dir, 'inbox.json'), bearerToken: 'legacy-shared-token-that-is-at-least-32-bytes', identityDirectory: f.directory, sessionAuthority: f.authority });
  const address = await node.listen();
  t.after(() => node.close());
  const base = `http://127.0.0.1:${address.port}`;
  async function http(path, init = {}, token = '') {
    const headers = { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers };
    return fetch(base + path, { ...init, headers });
  }
  async function httpLogin(profile, keys) {
    const cRes = await http('/api/v1/auth/challenge', { method: 'POST', body: JSON.stringify({ identityId: profile.identityId }) });
    assert.equal(cRes.status, 200);
    const challenge = (await cRes.json()).challenge;
    const sRes = await http('/api/v1/auth/session', { method: 'POST', body: JSON.stringify(createSocialAuthenticationProof(challenge, keys.signingPrivateKeyPem)) });
    assert.equal(sRes.status, 200);
    return (await sRes.json()).token;
  }
  const aliceToken = await httpLogin(f.alice, f.aliceKeys);
  const bobToken = await httpLogin(f.bob, f.bobKeys);
  const envelope = encryptSocialMessage({ senderId: f.alice.identityId, recipientId: f.bob.identityId, plaintext: 'private session-bound message', senderSigningPrivateKeyPem: f.aliceKeys.signingPrivateKeyPem, senderSigningPublicKeyPem: f.aliceKeys.signingPublicKeyPem, recipientEncryptionPublicKeyPem: f.bobKeys.encryptionPublicKeyPem });
  assert.equal((await http('/api/v1/messages', { method: 'POST', body: JSON.stringify(envelope) }, aliceToken)).status, 202);
  assert.equal((await http(`/api/v1/inbox?recipient=${encodeURIComponent(f.bob.identityId)}`, {}, aliceToken)).status, 403);
  const inboxResponse = await http(`/api/v1/inbox?recipient=${encodeURIComponent(f.bob.identityId)}`, {}, bobToken);
  assert.equal(inboxResponse.status, 200);
  const queued = (await inboxResponse.json()).messages;
  assert.equal(queued.length, 1);
  const ack = createSocialMessageAcknowledgement({ recipientId: f.bob.identityId, queueIds: [queued[0].queueId], recipientSigningPrivateKeyPem: f.bobKeys.signingPrivateKeyPem });
  assert.equal((await http('/api/v1/inbox/ack', { method: 'POST', body: JSON.stringify(ack) }, aliceToken)).status, 403);
  assert.equal((await http('/api/v1/inbox/ack', { method: 'POST', body: JSON.stringify(ack) }, bobToken)).status, 200);
  assert.equal((await http('/api/v1/inbox?recipient=' + encodeURIComponent(f.bob.identityId), {}, 'legacy-shared-token-that-is-at-least-32-bytes')).status, 401);
});

test('HTTP session endpoint rejects replayed proof and missing session tokens', async t => {
  const f = await fixture(t);
  const node = new SocialMessageNode({ filePath: join(f.dir, 'inbox.json'), bearerToken: 'legacy-shared-token-that-is-at-least-32-bytes', identityDirectory: f.directory, sessionAuthority: f.authority });
  const address = await node.listen(); t.after(() => node.close());
  const base = `http://127.0.0.1:${address.port}`;
  const challenge = await (await fetch(base + '/api/v1/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityId: f.alice.identityId }) })).json();
  const proof = createSocialAuthenticationProof(challenge.challenge, f.aliceKeys.signingPrivateKeyPem);
  const first = await fetch(base + '/api/v1/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
  assert.equal(first.status, 200);
  const replay = await fetch(base + '/api/v1/auth/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(proof) });
  assert.equal(replay.status, 401);
  const noSession = await fetch(base + '/api/v1/inbox?recipient=' + encodeURIComponent(f.alice.identityId));
  assert.equal(noSession.status, 401);
});
