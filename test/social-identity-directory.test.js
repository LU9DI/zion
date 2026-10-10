import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocialIdentityRegistration, SocialIdentityDirectory, verifySocialIdentityRegistration } from '../src/social-identity-directory.js';
import { generateSocialIdentityKeys } from '../src/social-message-protocol.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zion-identity-directory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const directory = new SocialIdentityDirectory({ filePath: join(dir, 'profiles.json'), ...options });
  await directory.init();
  return { dir, directory };
}
function registration(username, keys, createdAt = Date.now()) {
  return createSocialIdentityRegistration({ username, signingPrivateKeyPem: keys.signingPrivateKeyPem, signingPublicKeyPem: keys.signingPublicKeyPem, encryptionPublicKeyPem: keys.encryptionPublicKeyPem, createdAt });
}

test('registration proves control of signing key and derives stable identity fingerprint', () => {
  const keys = generateSocialIdentityKeys();
  const profile = registration('alice_1', keys);
  assert.match(profile.identityId, /^zion:[a-f0-9]{64}$/);
  assert.equal(verifySocialIdentityRegistration(profile), true);
  assert.equal(verifySocialIdentityRegistration({ ...profile, username: 'mallory' }), false);
  assert.equal(verifySocialIdentityRegistration({ ...profile, identityId: 'zion:00' }), false);
});

test('directory registers profile, resolves by id and username, and omits private keys', async t => {
  const { directory } = await fixture(t);
  const keys = generateSocialIdentityKeys();
  const profile = registration('alice_1', keys);
  const result = await directory.register(profile);
  assert.equal(result.created, true);
  assert.equal((await directory.getById(profile.identityId)).username, 'alice_1');
  assert.equal((await directory.getByUsername('alice_1')).identityId, profile.identityId);
  assert.equal(JSON.stringify(result.profile).includes('PrivateKey'), false);
  assert.equal((await directory.stats()).profiles, 1);
});

test('directory persists profiles and validates stored proof on restart', async t => {
  const { dir, directory } = await fixture(t);
  const keys = generateSocialIdentityKeys();
  const profile = registration('bob_22', keys);
  await directory.register(profile);
  const restarted = new SocialIdentityDirectory({ filePath: join(dir, 'profiles.json') });
  assert.equal((await restarted.getByUsername('bob_22')).identityId, profile.identityId);
  const file = JSON.parse(await readFile(join(dir, 'profiles.json'), 'utf8'));
  assert.equal(file.schema, 1);
  assert.equal(file.profiles.length, 1);
});

test('duplicate username is rejected and identical registration is idempotent', async t => {
  const { directory } = await fixture(t);
  const alice = registration('same_name', generateSocialIdentityKeys());
  assert.equal((await directory.register(alice)).created, true);
  assert.equal((await directory.register(alice)).created, false);
  await assert.rejects(directory.register(registration('same_name', generateSocialIdentityKeys())), /username already taken/);
});

test('rejects malformed, stale, future, and oversized registrations', async t => {
  const { directory } = await fixture(t);
  const keys = generateSocialIdentityKeys();
  assert.throws(() => registration('Bad Name', keys), /username/);
  const stale = registration('stale_user', keys, Date.now() - 11 * 60 * 1000);
  await assert.rejects(directory.register(stale), /invalid or expired/);
  const future = registration('future_user', generateSocialIdentityKeys(), Date.now() + 60_000);
  await assert.rejects(directory.register(future), /invalid or expired/);
  await assert.rejects(directory.list({ limit: 101 }), /limit/);
});

test('directory refuses tampered persistent records', async t => {
  const { dir, directory } = await fixture(t);
  const profile = registration('tamper_user', generateSocialIdentityKeys());
  await directory.register(profile);
  const path = join(dir, 'profiles.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.profiles[0].username = 'other_name';
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, JSON.stringify(data));
  const reopened = new SocialIdentityDirectory({ filePath: path });
  await assert.rejects(reopened.init(), /invalid stored identity profile/);
});
