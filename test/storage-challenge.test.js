import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageCommitment, createStorageChallenge, answerStorageChallenge, verifyStorageChallengeResponse } from '../src/storage-challenge.js';

test('proves sampled leaves against a Merkle commitment without transferring the full object', () => {
  const data=Buffer.alloc(19_321); for(let i=0;i<data.length;i++)data[i]=i%251;
  const commitment=createStorageCommitment(data,{leafSize:1024});
  const challenge=createStorageChallenge({commitment,sampleCount:5,challengeId:'d'.repeat(32)});
  const response=answerStorageChallenge(data,challenge);
  const result=verifyStorageChallengeResponse({challenge,response});
  assert.equal(result.ok,true); assert.equal(result.verifiedSamples,5);
  assert.ok(response.samples.reduce((n,s)=>n+Buffer.from(s.bytes,'base64').length,0)<data.length);
});

test('rejects changed samples, missing proofs, and data that no longer matches its commitment', () => {
  const data=Buffer.alloc(8000,7), commitment=createStorageCommitment(data,{leafSize:512});
  const challenge=createStorageChallenge({commitment,sampleCount:4,challengeId:'e'.repeat(32)});
  const response=answerStorageChallenge(data,challenge);
  const bad={...response,samples:response.samples.map((s,i)=>i? s:{...s,bytes:Buffer.from('tampered').toString('base64')})};
  assert.equal(verifyStorageChallengeResponse({challenge,response:bad}).ok,false);
  assert.throws(()=>answerStorageChallenge(Buffer.alloc(8000,8),challenge),{code:'ZION_STORAGE_COMMITMENT_MISMATCH'});
  assert.equal(verifyStorageChallengeResponse({challenge,response:{...response,samples:response.samples.slice(1)}}).ok,false);
});
