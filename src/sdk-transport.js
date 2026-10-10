import { createHash } from 'node:crypto';

const ID=/^[a-zA-Z0-9._:-]{1,128}$/;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** Transport contract used by the SDK: send(peerId, message, options) -> Promise<response>. */
export function assertTransportAdapter(adapter) {
  if(!adapter||typeof adapter.send!=='function')throw new TypeError('TransportAdapter must implement send(peerId, message, options)');
  return adapter;
}

/** Independent in-process nodes with isolated state and deterministic latency/drop injection. Not a network simulator. */
export class LocalSandboxTransport {
  constructor({latencyMs=0,latencyJitterMs=0,dropEvery=0,seed='zion-sandbox-v1',maxNodes=32}={}) {
    if(![latencyMs,latencyJitterMs,dropEvery,maxNodes].every(Number.isSafeInteger)||latencyMs<0||latencyJitterMs<0||dropEvery<0||maxNodes<1||maxNodes>256||typeof seed!=='string'||seed.length>256)throw new TypeError('Invalid local sandbox configuration');
    this.latencyMs=latencyMs;this.latencyJitterMs=latencyJitterMs;this.dropEvery=dropEvery;this.seed=seed;this.maxNodes=maxNodes;this.sequence=0;this.nodes=new Map();this.closed=false;
  }
  registerNode({nodeId,handler,state=new Map()}={}) {
    if(this.closed)throw new Error('Sandbox transport is closed');
    if(typeof nodeId!=='string'||!ID.test(nodeId)||typeof handler!=='function'||!(state instanceof Map))throw new TypeError('Invalid sandbox node');
    if(this.nodes.has(nodeId)||this.nodes.size>=this.maxNodes)throw new Error('Duplicate node or sandbox node capacity reached');
    this.nodes.set(nodeId,{handler,state});
    return Object.freeze({nodeId,state});
  }
  async send(peerId,message,{signal}={}) {
    if(this.closed)throw new Error('Sandbox transport is closed');
    if(signal?.aborted)throw Object.assign(new Error('Operation aborted'),{name:'AbortError'});
    const node=this.nodes.get(peerId);if(!node)throw Object.assign(new Error('Unknown sandbox peer'),{code:'ZION_PEER_NOT_FOUND'});
    const seq=++this.sequence;
    const digest=createHash('sha256').update(this.seed).update(':').update(String(seq)).digest();
    const jitter=this.latencyJitterMs?digest.readUInt32BE(0)%(this.latencyJitterMs+1):0;
    const delay=this.latencyMs+jitter;
    if(delay)await sleep(delay);
    if(signal?.aborted)throw Object.assign(new Error('Operation aborted'),{name:'AbortError'});
    if(this.dropEvery>0&&seq%this.dropEvery===0)throw Object.assign(new Error('Injected sandbox packet loss'),{code:'ZION_SANDBOX_PACKET_LOSS'});
    return node.handler(message,{from:'sandbox',sequence:seq,state:node.state});
  }
  async close(){this.closed=true;this.nodes.clear();}
  snapshot(){return Object.freeze({closed:this.closed,nodeCount:this.nodes.size,requests:this.sequence,mode:'local-sandbox'});}
}

/** All requests race, but only a caller-validated response can win. */
export async function raceValidatedRequests({transport,peerIds,message,validate,signal}={}) {
  assertTransportAdapter(transport);
  if(!Array.isArray(peerIds)||peerIds.length<1||peerIds.length>64||typeof validate!=='function')throw new TypeError('Invalid racing request configuration');
  const unique=[...new Set(peerIds)];
  const errors=[];
  let pending=unique.length;
  return new Promise((resolve,reject)=>{
    let settled=false;
    for(const peerId of unique){
      Promise.resolve().then(()=>transport.send(peerId,message,{signal})).then(async response=>{
        if(settled)return;
        let valid=false;try{valid=await validate(response,peerId);}catch{}
        if(valid&&!settled){settled=true;resolve(Object.freeze({peerId,response}));}
        else {errors.push({peerId,reason:'invalid-response'});if(--pending===0&&!settled){settled=true;reject(Object.assign(new Error('No peer returned a valid response'),{code:'ZION_NO_VALID_RACE_RESPONSE',errors}));}}
      }).catch(error=>{
        if(settled)return;errors.push({peerId,reason:error?.code??error?.name??'request-failed'});
        if(--pending===0&&!settled){settled=true;reject(Object.assign(new Error('No peer returned a valid response'),{code:'ZION_NO_VALID_RACE_RESPONSE',errors}));}
      });
    }
  });
}

/** No silent fallback: real P2P mode requires a real adapter supplied by the caller. */
export function initZionSDK({mode='local-sandbox',transportAdapter,nodeCount=5,latencyMs=0,latencyJitterMs=0,dropEvery=0,seed='zion-sandbox-v1'}={}) {
  if(mode==='p2p-net')return Object.freeze({mode,transport:assertTransportAdapter(transportAdapter),close:()=>transportAdapter.close?.()});
  if(mode!=='local-sandbox')throw new TypeError('Unsupported Zion SDK mode');
  if(!Number.isSafeInteger(nodeCount)||nodeCount<1||nodeCount>32)throw new RangeError('local-sandbox nodeCount must be 1..32');
  const transport=new LocalSandboxTransport({latencyMs,latencyJitterMs,dropEvery,seed,maxNodes:nodeCount});
  const nodes=[];
  for(let i=0;i<nodeCount;i++){const nodeId='sandbox-'+String(i+1).padStart(2,'0');const state=new Map();transport.registerNode({nodeId,state,handler:async(message)=>({ok:true,nodeId,echo:message})});nodes.push(Object.freeze({nodeId,state}));}
  return Object.freeze({mode,transport,nodes:Object.freeze(nodes),close:()=>transport.close()});
}
