import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createNodeIdentity, signPeerMessage, verifyPeerMessage } from '../src/peer-security.js';
import {
  createEncryptedNodeIdentityRecord,
  loadEncryptedNodeIdentityRecord,
} from '../src/node-identity-record.js';

// Test-only OS-keystore substitute. It deliberately lives only in this test file;
// production must use a real platform credential store and cross-process provisioning.
class FakeKeystore {
  constructor(masterKey = Buffer.alloc(32, 0x5a)) {
    this.masterKey = Buffer.from(masterKey);
    this.created = [];
  }

  async createOrGetWrappingKey(request) {
    this.created.push({ ...request });
  }

  async wrapKey({ plaintextKey }) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  async unwrapKey({ wrappedKey }) {
    const bytes = Buffer.from(wrappedKey);
    if (bytes.length < 29) throw new Error('Invalid fake wrapped key');
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}

const NOW = 1_800_000_000_000;

test('encrypted node identity round-trips without changing node ID or signing identity', async () => {
  const identity = createNodeIdentity();
  const keystore = new FakeKeystore();
  const record = await createEncryptedNodeIdentityRecord(identity, keystore, {
    keyId: 'zion-node-identity:test-roundtrip',
  });

  assert.equal(record.nodeId, identity.nodeId);
  assert.equal(record.algorithm, 'Ed25519');
  assert.equal(record.cipher, 'AES-256-GCM');
  assert.equal(keystore.created.length, 1);
  assert.deepEqual(keystore.created[0], {
    keyId: 'zion-node-identity:test-roundtrip',
    purpose: 'zion-node-identity-dek-v1',
  });
  assert.equal(Object.hasOwn(record, 'privateKey'), false);
  assert.equal(JSON.stringify(record).includes(identity.privateKey.export({
    type: 'pkcs8', format: 'pem',
  }).toString()), false);

  const restored = await loadEncryptedNodeIdentityRecord(record, keystore);
  assert.equal(restored.nodeId, identity.nodeId);
  assert.equal(restored.publicKeyPem, identity.publicKeyPem);

  const originalMessage = signPeerMessage(identity, { type: 'IDENTITY_TEST' }, { now: NOW });
  const restoredMessage = signPeerMessage(restored, { type: 'IDENTITY_TEST' }, { now: NOW });
  assert.equal(verifyPeerMessage(originalMessage, { now: NOW }).ok, true);
  assert.equal(verifyPeerMessage(restoredMessage, { now: NOW }).ok, true);
  assert.equal(verifyPeerMessage(originalMessage, { now: NOW }).nodeId, restored.nodeId);
  assert.equal(verifyPeerMessage(restoredMessage, { now: NOW }).nodeId, identity.nodeId);
});

test('encrypted identity rejects ciphertext and authenticated metadata tampering', async () => {
  const identity = createNodeIdentity();
  const keystore = new FakeKeystore();
  const record = await createEncryptedNodeIdentityRecord(identity, keystore);

  const alteredCiphertext = { ...record, ciphertext: Buffer.from('tampered').toString('base64') };
  await assert.rejects(loadEncryptedNodeIdentityRecord(alteredCiphertext, keystore));

  const alteredNodeId = { ...record, nodeId: 'f'.repeat(64) };
  await assert.rejects(loadEncryptedNodeIdentityRecord(alteredNodeId, keystore), /node ID/);

  const alteredKeyId = { ...record, keyId: 'zion-node-identity:other-slot' };
  await assert.rejects(loadEncryptedNodeIdentityRecord(alteredKeyId, keystore));

  // Recompute nodeId so validation reaches AES-GCM authentication. The public
  // key bytes are still authenticated metadata and must not be substitutable.
  const alteredPublicDer = Buffer.from(record.publicKeyDer, 'base64');
  alteredPublicDer[0] ^= 0x01;
  const alteredPublicKey = alteredPublicDer.toString('base64');
  const alteredPublicKeyNodeId = createHash('sha256').update(alteredPublicDer).digest('hex');
  await assert.rejects(loadEncryptedNodeIdentityRecord({
    ...record,
    publicKeyDer: alteredPublicKey,
    nodeId: alteredPublicKeyNodeId,
  }, keystore));

  const unknownField = { ...record, unexpected: true };
  await assert.rejects(loadEncryptedNodeIdentityRecord(unknownField, keystore), /invalid schema/);
});

test('encrypted identity wipes the keystore-returned plaintext DEK buffer after restore', async () => {
  const identity = createNodeIdentity();
  const backingKeystore = new FakeKeystore();
  const record = await createEncryptedNodeIdentityRecord(identity, backingKeystore);
  let returnedPlaintext;
  const observingKeystore = {
    async unwrapKey(request) {
      returnedPlaintext = await backingKeystore.unwrapKey(request);
      return returnedPlaintext;
    },
  };

  const restored = await loadEncryptedNodeIdentityRecord(record, observingKeystore);
  assert.equal(restored.nodeId, identity.nodeId);
  assert.ok(Buffer.isBuffer(returnedPlaintext));
  assert.equal(returnedPlaintext.every(byte => byte === 0), true);
});

test('encrypted identity wipes keystore plaintext when authenticated decryption fails', async () => {
  const identity = createNodeIdentity();
  const record = await createEncryptedNodeIdentityRecord(identity, new FakeKeystore());
  const wrongPlaintext = Buffer.alloc(32, 0x7f);
  const observingKeystore = {
    async unwrapKey() {
      return wrongPlaintext;
    },
  };

  await assert.rejects(loadEncryptedNodeIdentityRecord(record, observingKeystore));
  assert.equal(wrongPlaintext.every(byte => byte === 0), true);
});

test('encrypted identity rejects non-byte keystore plaintext without masking the adapter error', async () => {
  const identity = createNodeIdentity();
  const record = await createEncryptedNodeIdentityRecord(identity, new FakeKeystore());
  const invalidKeystore = {
    async unwrapKey() {
      return new ArrayBuffer(32);
    },
  };

  await assert.rejects(
    loadEncryptedNodeIdentityRecord(record, invalidKeystore),
    { name: 'TypeError', message: 'Local keystore must return unwrapped key bytes' },
  );
});

test('encrypted identity rejects a wrong local wrapping credential', async () => {
  const identity = createNodeIdentity();
  const record = await createEncryptedNodeIdentityRecord(identity, new FakeKeystore());
  await assert.rejects(
    loadEncryptedNodeIdentityRecord(record, new FakeKeystore(Buffer.alloc(32, 0x33))),
  );
});

test('encrypted identity creation rejects mismatched private key, public key and node ID', async () => {
  const identity = createNodeIdentity();
  const otherIdentity = createNodeIdentity();
  await assert.rejects(
    createEncryptedNodeIdentityRecord({
      ...identity,
      publicKeyPem: otherIdentity.publicKeyPem,
    }, new FakeKeystore()),
    /does not match/,
  );
});

test('encrypted identity creation rejects malformed keystore adapters before writing', async () => {
  const identity = createNodeIdentity();
  await assert.rejects(
    createEncryptedNodeIdentityRecord(identity, { wrapKey: async () => Buffer.alloc(32) }),
    /createOrGetWrappingKey/,
  );
});

test('encrypted identity creation rejects caller-controlled random sources before keystore access', async () => {
  const identity = createNodeIdentity();
  const keystore = new FakeKeystore();
  let randomCalls = 0;
  await assert.rejects(
    createEncryptedNodeIdentityRecord(identity, keystore, {
      keyId: 'zion-node-identity:custom-rng-rejected',
      random() {
        randomCalls += 1;
        return Buffer.alloc(32, 0x42);
      },
    }),
    /Node identity options has an invalid schema/,
  );
  assert.equal(randomCalls, 0);
  assert.equal(keystore.created.length, 0);
});


test('encrypted identity rejects malformed and oversized encoded fields before keystore access', async () => {
  const identity = createNodeIdentity();
  const record = await createEncryptedNodeIdentityRecord(identity, new FakeKeystore());
  let unwrapCalls = 0;
  const observingKeystore = {
    async unwrapKey() {
      unwrapCalls += 1;
      throw new Error('unwrap must not be reached for malformed records');
    },
  };

  const invalidPublicDer = Buffer.from('not-an-ed25519-spki');
  const malformedRecords = [
    { ...record, publicKeyDer: '!!!!' },
    { ...record, publicKeyDer: 'A'.repeat(1024 * 1024) },
    {
      ...record,
      publicKeyDer: invalidPublicDer.toString('base64'),
      nodeId: createHash('sha256').update(invalidPublicDer).digest('hex'),
    },
    { ...record, nonce: 'abc' },
    { ...record, ciphertext: Buffer.alloc(16 * 1024 + 1, 0x41).toString('base64') },
    { ...record, authTag: Buffer.from([0x01]).toString('base64') },
    { ...record, wrappedDek: Buffer.alloc(4097, 0x42).toString('base64') },
  ];

  for (const malformed of malformedRecords) {
    await assert.rejects(loadEncryptedNodeIdentityRecord(malformed, observingKeystore));
  }
  assert.equal(unwrapCalls, 0);
});
