import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createStorageCommitment, answerStorageChallenge } from '../src/storage-challenge.js';
import { StorageAuditSessions, signStorageAuditResponse, verifyStorageAuditChallenge } from '../src/storage-audit-sessions.js';

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type:'spki', format:'pem' });
  return { publicKeyPem, privateKey, nodeId:createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex') };
}
test('storage audit binds challenge and response signatures to identities and consumes proof once', () => {
  const auditor = identity(), peer = identity(), data = Buffer.alloc(9000, 31);
  const sessions = new StorageAuditSessions({ auditorIdentity:auditor, isTrustedPeer:id=>id===peer.nodeId });
  const envelope = sessions.issue({ commitment:createStorageCommitment(data,{leafSize:512}), peerNodeId:peer.nodeId, sampleCount:4 });
  assert.equal(verifyStorageAuditChallenge(envelope,{isTrustedAuditor:id=>id===auditor.nodeId}).ok,true);
  const response = answerStorageChallenge(data,envelope.challenge);
  const signedResponse = signStorageAuditResponse({response,peerIdentity:peer});
  const result = sessions.verify({envelope,signedResponse});
  assert.equal(result.ok,true);
  assert.equal(result.verifiedSamples,4);
  assert.equal(sessions.pendingCount,0);
  assert.equal(sessions.verify({envelope,signedResponse}).reason,'replay');
});
test('storage audit rejects wrong peer, tampered signature, untrusted auditor and invalid proof', () => {
  const auditor=identity(), peer=identity(), other=identity(), data=Buffer.alloc(6000, 8);
  const sessions=new StorageAuditSessions({auditorIdentity:auditor,isTrustedPeer:id=>id===peer.nodeId});
  const envelope=sessions.issue({commitment:createStorageCommitment(data,{leafSize:512}),peerNodeId:peer.nodeId});
  assert.equal(verifyStorageAuditChallenge(envelope,{isTrustedAuditor:()=>false}).ok,false);
  const response=answerStorageChallenge(data,envelope.challenge);
  assert.equal(sessions.verify({envelope,signedResponse:signStorageAuditResponse({response,peerIdentity:other})}).ok,false);
  const signed=signStorageAuditResponse({response,peerIdentity:peer});
  assert.equal(sessions.verify({envelope,signedResponse:{...signed,signature:Buffer.from('invalid').toString('base64')}}).ok,false);
  const badResponse={...response,root:'f'.repeat(64)};
  assert.equal(sessions.verify({envelope,signedResponse:signStorageAuditResponse({response:badResponse,peerIdentity:peer})}).ok,false);
});
test('storage audit expires pending sessions and enforces bounded capacity', () => {
  const auditor=identity(), peer=identity(), data=Buffer.alloc(2048, 2); let now=1000;
  const sessions=new StorageAuditSessions({auditorIdentity:auditor,now:()=>now,ttlMs:1000,maxPending:1});
  const commitment=createStorageCommitment(data,{leafSize:512});
  sessions.issue({commitment,peerNodeId:peer.nodeId});
  assert.throws(()=>sessions.issue({commitment,peerNodeId:peer.nodeId}),{code:'ZION_AUDIT_CAPACITY'});
  now=2001;
  assert.equal(sessions.verify({envelope:{challenge:{challengeId:'a'.repeat(32)}}}).reason,'unknown-or-expired-challenge');
  assert.equal(sessions.issue({commitment,peerNodeId:peer.nodeId}).challenge.root,commitment.root);
});
