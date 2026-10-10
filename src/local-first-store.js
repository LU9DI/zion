import { createHash, randomBytes } from 'node:crypto';

const ID=/^[a-zA-Z0-9._:-]{1,128}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
function canonical(value){if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('Non-finite record number');return JSON.stringify(value);}if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(typeof value==='object'){if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new TypeError('Only plain record objects are supported');return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}throw new TypeError('Unsupported record value');}
export function hashLocalFirstRecord(record){if(!record||typeof record!=='object')throw new TypeError('Invalid record');const {hash,...body}=record;return sha(canonical(body));}
/** Small local-first append-only record store. Persistence/encryption are injected, not implied. */
export class LocalFirstStore {
  constructor({persistLocal=async()=>{},replicateAsync=async()=>{},maxRecords=100_000,onReplicationError=()=>{},verifyRemoteRecord=async()=>false}={}) {
    if(typeof persistLocal!=='function'||typeof replicateAsync!=='function'||typeof onReplicationError!=='function'||typeof verifyRemoteRecord!=='function'||!Number.isSafeInteger(maxRecords)||maxRecords<1)throw new TypeError('Invalid local-first store configuration');
    this.persistLocal=persistLocal;this.replicateAsync=replicateAsync;this.maxRecords=maxRecords;this.onReplicationError=onReplicationError;this.verifyRemoteRecord=verifyRemoteRecord;this.records=new Map();this.heads=new Map();this.conflicts=new Map();this.replicationTasks=new Set();
  }
  async write({key,parentHash=null,value,deviceId}={}) {
    if(typeof key!=='string'||!ID.test(key)||typeof deviceId!=='string'||!ID.test(deviceId)||!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Invalid local-first record');
    if(this.conflicts.has(key))throw Object.assign(new Error('Key has unresolved concurrent edits'),{code:'ZION_CONFLICT_UNRESOLVED',conflict:this.conflicts.get(key)});
    const current=this.heads.get(key)??null;
    if(parentHash!==current)throw Object.assign(new Error('Write parent does not match current local head'),{code:'ZION_STALE_PARENT',expectedParent:current});
    if(this.records.size>=this.maxRecords)throw new Error('Local-first record capacity reached');
    const record={version:1,key,parentHash,deviceId,createdAt:Date.now(),recordId:randomBytes(16).toString('hex'),value};
    record.hash=hashLocalFirstRecord(record);
    Object.freeze(record);
    await this.persistLocal(record); // local durability precedes network replication
    this.records.set(record.hash,record);this.heads.set(key,record.hash);
    const task=Promise.resolve().then(()=>this.replicateAsync(record)).catch(async error=>{try{await this.onReplicationError({key,recordHash:record.hash,message:String(error?.message??'replication failed').slice(0,240)});}catch{} return {ok:false,reason:'replication-failed'};}).then(result=>result??{ok:true}).finally(()=>this.replicationTasks.delete(task));
    this.replicationTasks.add(task);
    return Object.freeze({record,localCommitted:true,replication:task});
  }
  /** Import an authenticated remote record. Same-parent siblings are preserved as an explicit conflict. */
  async ingestRemote(record,context={}) {
    let authenticated=false;try{authenticated=await this.verifyRemoteRecord(record,context);}catch{}
    if(authenticated!==true)return {ok:false,reason:'unauthenticated-record'};
    if(!record||typeof record.key!=='string'||!ID.test(record.key)||typeof record.hash!=='string'||!/^[a-f0-9]{64}$/.test(record.hash)||(record.parentHash!==null&&typeof record.parentHash!=='string'))return {ok:false,reason:'invalid-record'};
    try{if(hashLocalFirstRecord(record)!==record.hash)return {ok:false,reason:'record-hash-mismatch'};}catch{return {ok:false,reason:'invalid-record'};}
    const current=this.heads.get(record.key)??null;
    if(record.parentHash!==current&&record.hash!==current){
      if(!this.records.has(record.hash)){await this.persistLocal(record);this.records.set(record.hash,Object.freeze({...record}));}
      const branches=new Set([current,record.hash].filter(Boolean));
      this.conflicts.set(record.key,Object.freeze({key:record.key,branches:Object.freeze([...branches]),detectedAt:Date.now(),status:'unresolved'}));
      return {ok:false,reason:'fork-detected',conflict:this.conflicts.get(record.key)};
    }
    if(this.records.has(record.hash))return {ok:true,duplicate:true};
    await this.persistLocal(record);this.records.set(record.hash,Object.freeze({...record}));this.heads.set(record.key,record.hash);
    return {ok:true};
  }
  async resolveConflict(key,{keepHashes,mergedValue,deviceId}={}) {
    const conflict=this.conflicts.get(key);
    if(!conflict)throw new Error('No unresolved conflict for key');
    if(!Array.isArray(keepHashes)||keepHashes.length<1||keepHashes.some(h=>!conflict.branches.includes(h)))throw new TypeError('Resolution must explicitly reference known branches');
    if(typeof deviceId!=='string'||!ID.test(deviceId))throw new TypeError('Resolution deviceId is required');
    if(this.records.size>=this.maxRecords)throw new Error('Local-first record capacity reached');
    const base={version:1,key,parentHash:null,parentHashes:Object.freeze([...new Set(keepHashes)]),deviceId,createdAt:Date.now(),recordId:randomBytes(16).toString('hex'),value:mergedValue??null,resolution:true};
    const record=Object.freeze({...base,hash:hashLocalFirstRecord(base)});
    await this.persistLocal(record);this.records.set(record.hash,record);this.heads.set(key,record.hash);this.conflicts.delete(key);
    return record;
  }
  get(key){const head=this.heads.get(key);return head?this.records.get(head)??null:null;}
  getConflict(key){return this.conflicts.get(key)??null;}
  async flush(){await Promise.allSettled([...this.replicationTasks]);}
}
