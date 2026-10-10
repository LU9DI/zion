import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeIdentity } from '../src/peer-security.js';
import { createStoreRequest, createStoreReceipt } from '../src/replication-receipts.js';
import { PeerReputation } from '../src/peer-reputation.js';

test('counts only valid signed receipts and authenticated unique audit outcomes',()=>{
 let now=1000;const peer=createNodeIdentity();
 const request=createStoreRequest({chunkId:'a'.repeat(64),bytes:100,targetNodeId:peer.nodeId,now});
 const message=createStoreReceipt(peer,request,{storedBytes:100,now:1001});
 const reputation=new PeerReputation({now:()=>now,verifyAuditEvidence:async evidence=>evidence?.signature==='trusted'});
 now=1001;assert.equal(reputation.recordReceipt({message,request}).ok,true);
 assert.equal(reputation.recordReceipt({message,request}).reason,'duplicate-receipt-evidence');
 assert.equal((await reputation.recordAuditOutcome({nodeId:peer.nodeId,outcome:'failure',evidenceId:'audit-1',evidence:{signature:'untrusted'}})).ok,false);
 assert.equal((await reputation.recordAuditOutcome({nodeId:peer.nodeId,outcome:'failure',evidenceId:'audit-1',evidence:{signature:'trusted'}})).ok,true);
 assert.equal((await reputation.recordAuditOutcome({nodeId:peer.nodeId,outcome:'failure',evidenceId:'audit-1',evidence:{signature:'trusted'}})).reason,'duplicate-audit-evidence');
 assert.equal(reputation.summary(peer.nodeId).auditFailures,1);
});
