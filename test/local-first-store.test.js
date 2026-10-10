import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFirstStore, hashLocalFirstRecord } from '../src/local-first-store.js';

test('commits locally before async replication settles',async()=>{
 let resolveReplication;let persisted=0;
 const store=new LocalFirstStore({persistLocal:async()=>{persisted++},replicateAsync:()=>new Promise(resolve=>{resolveReplication=resolve})});
 const result=await store.write({key:'doc',deviceId:'laptop',value:{text:'local'}});
 assert.equal(persisted,1);assert.equal(result.localCommitted,true);assert.equal(store.get('doc').value.text,'local');
 resolveReplication({ok:true});await result.replication;
});

test('detects same-parent forks and blocks writes until explicit resolution',async()=>{
 const store=new LocalFirstStore({verifyRemoteRecord:async record=>record?.deviceId==='phone'});
 const local=await store.write({key:'doc',deviceId:'laptop',value:{v:1}});
 const remoteBase={version:1,key:'doc',parentHash:null,deviceId:'phone',createdAt:2,recordId:'remote',value:{v:2}};
 const remote={...remoteBase,hash:hashLocalFirstRecord(remoteBase)};
 const fork=await store.ingestRemote(remote);
 assert.equal(fork.reason,'fork-detected');
 await assert.rejects(store.write({key:'doc',parentHash:local.record.hash,deviceId:'laptop',value:{v:3}}),{code:'ZION_CONFLICT_UNRESOLVED'});
 const resolution=await store.resolveConflict('doc',{keepHashes:fork.conflict.branches,mergedValue:{v:3},deviceId:'laptop'});
 assert.equal(resolution.parentHashes.length,2);assert.equal(store.getConflict('doc'),null);assert.equal(store.get('doc').value.v,3);
});

test('rejects unauthenticated remote records',async()=>{
 const store=new LocalFirstStore();
 assert.deepEqual(await store.ingestRemote({key:'doc',hash:'a'.repeat(64),parentHash:null}),{ok:false,reason:'unauthenticated-record'});
 assert.deepEqual(await new LocalFirstStore({verifyRemoteRecord:async()=>true}).ingestRemote({key:'doc',hash:'a'.repeat(64),parentHash:null}),{ok:false,reason:'record-hash-mismatch'});
});
