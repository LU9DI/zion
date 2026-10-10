import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRemoteWitness } from '../scripts/request-remote-witness.js';

test('remote witness client rejects plaintext HTTP outside loopback before reading credentials', async () => {
  await assert.rejects(requestRemoteWitness({ endpoint: 'http://witness.example/v1/witness/challenge', historyPath: '/missing', tokenFile: '/missing', publicKeyPath: '/missing', expectedWitnessId: 'witness-a', expectedWitnessKeyId: 'key-a', outputPath: '/missing' }), /Plain HTTP is permitted only for loopback/);
});

test('remote witness client rejects endpoint query, fragment, and non-challenge routes', async () => {
  for (const endpoint of [
    'https://witness.example/v1/witness/challenge?redirect=1',
    'https://witness.example/v1/witness/challenge#fragment',
    'https://witness.example/other',
    'https://user:pass@witness.example/v1/witness/challenge',
  ]) {
    await assert.rejects(requestRemoteWitness({ endpoint, historyPath: '/missing', tokenFile: '/missing', publicKeyPath: '/missing', expectedWitnessId: 'witness-a', expectedWitnessKeyId: 'key-a', outputPath: '/missing' }), /Endpoint must be/);
  }
});
