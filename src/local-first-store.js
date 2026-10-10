import { createHash, randomBytes } from 'node:crypto';

const ID=/^[a-zA-Z0-9._:-]{1,128}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value));
/** Small local-first append-only record store. Persistence/encryption are injected, not implied. */
export class LocalFirstStore {
  constructor({persistLocal=async()=>{},replicateAsync=async()=>{},maxRecords=100_000,onReplicationError=()=>{}}={}) {
    if(typeof persistLocal!=='function'||typeof replicateAsync!=='function'||typeof onReplicationError!=='function'||!Number.isSafeInteger(maxRecords)||maxRecords<1)throw new TypeError('Invalid local-first store configuration');
    this.persistLocal=persistLocal;this.replicateAsync=replicateAsync;this.maxRecords=maxRecords;this.onReplicationError=onReplicationError;this.records=new Map();this.heads=new Map();this.conflicts=new Map();this.replicationTasks=new Set();
  }
  async write({key,parentHash=null,value,deviceId}={}) {
    if(typeof key!=='string'||!ID.test(key)||typeof deviceId!=='string'||!ID.test(deviceId)||!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid local-first record');
    if(this.conflicts.has(key))throw Object.assign(new Error('Key has unresolved concurrent edits'),{code:'ZION_CONFLICT_UNRESOLVED',conflict:this.conflicts.get(key)});
    const current=this.heads.get(key)??null;
    if(parentHash!==current)throw Object.assign(new Error('Write parent does not match current local head'),{code:'ZION_STALE_PARENT',expectedParent:current});
    if(this.records.size>=this.maxRecords)throw new Error('Local-first record capacity reached');
    const record={version:1,key,parentHash,deviceId,createdAt:Date.now(),recordId:randomBytes(16).toString('hex'),value};
    record.hash=sha(encode(record).toString('base64'));
    Object.freeze(record);
    await this.persistLocal(record); // local durability precedes network replication
    this.records.set(record.hash,record);this.heads.set(key,record.hash);
    const task=Promise.resolve().then(()=>this.replicateAsync(record)).catch(async error=>{try{await this.onReplicationError({key,recordHash:record.hash,message:String(error?.message??'replication failed').slice(0,240)});}catch{} return {ok:false,reason:'replication-failed'};}).then(result=>result??{ok:true}).finally(()=>this.replicationTasks.delete(task));
    this.replicationTasks.add(task);
    return Object.freeze({record,localCommitted:true,replication:task});
  }
  /** Import an authenticated remote record. Same-parent siblings are preserved as an explicit conflict. */
  async ingestRemote(record,{authenticated=false}={}) {
    if(!authenticated)return {ok:false,reason:'unauthenticated-record'};
    if(!record||typeof record.key!=='string'||!ID.test(record.key)||typeof record.hash!=='string'||!/^[a-f0-9]{64}$/.test(record.hash)||typeof record.parentHash!=='string')return {ok:false,reason:'invalid-record'};
    const current=this.heads.get(record.key)??null;
    if(record.parentHash!==current&&record.hash!==current){
      const branches=new Set([current,record.hash].filter(Boolean));
      this.conflicts.set(record.key,Object.freeze({key:record.key,branches:Object.freeze([...branches]),detectedAt:Date.now(),status:'unresolved'}));
      return {ok:false,reason:'fork-detected',conflict:this.conflicts.get(record.key)};
    }
    if(this.records.has(record.hash))return {ok:true,duplicate:true};
    await this.persistLocal(record);this.records.set(record.hash,Object.freeze({...record}));this.heads.set(record.key,record.hash);
    return {ok:true};
  }
  resolveConflict(key,{keepHashes,mergedValue,deviceId}={}) {
    const conflict=this.conflicts.get(key);
    if(!conflict)throw new Error('No unresolved conflict for key');
    if(!Array.isArray(keepHashes)||keepHashes.length<1||keepHashes.some(h=>!conflict.branches.includes(h)))throw new TypeError('Resolution must explicitly reference known branches');
    const resolution=Object.freeze({key,branches:Object.freeze([...new Set(keepHashes)]),mergedValue:mergedValue??null,deviceId,createdAt:Date.now(),resolutionId:randomBytes(16).toString('hex')});
    this.conflicts.delete(key);this.heads.set(key,sha(encode(resolution).toString('base64')));
    return resolution;
  }
  get(key){const head=this.heads.get(key);return head?this.records.get(head)??null:null;}
  getConflict(key){return this.conflicts.get(key)??null;}
  async flush(){await Promise.allSettled([...this.replicationTasks]);}
}
