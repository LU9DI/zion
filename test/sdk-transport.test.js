import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSandboxTransport, initZionSDK, raceValidatedRequests, assertTransportAdapter } from '../src/sdk-transport.js';

test('local sandbox creates independent in-process nodes and deterministic packet loss',async()=>{
 const sdk=initZionSDK({mode:'local-sandbox',nodeCount:5,dropEvery:2,seed:'test'});
 assert.equal(sdk.nodes.length,5);assert.notEqual(sdk.nodes[0].state,sdk.nodes[1].state);
 const first=await sdk.transport.send('sandbox-01',{x:1});assert.equal(first.nodeId,'sandbox-01');
 await assert.rejects(sdk.transport.send('sandbox-02',{x:2}),{code:'ZION_SANDBOX_PACKET_LOSS'});
 assert.equal(sdk.transport.snapshot().requests,2);await sdk.close();
});

test('racing rejects faster invalid responses and returns first validated response',async()=>{
 const transport=new LocalSandboxTransport();
 transport.registerNode({nodeId:'slow',handler:async()=>({ok:true,value:'slow'})});
 transport.registerNode({nodeId:'fast-invalid',handler:async()=>({ok:false,value:'bad'})});
 transport.registerNode({nodeId:'fast-valid',handler:async()=>({ok:true,value:'good'})});
 const winner=await raceValidatedRequests({transport,peerIds:['fast-invalid','fast-valid','slow'],message:{},validate:r=>r.ok&&r.value==='good'});
 assert.equal(winner.peerId,'fast-valid');assert.equal(winner.response.value,'good');await transport.close();
});

test('production mode refuses to invent a P2P transport',()=>{
 assert.throws(()=>initZionSDK({mode:'p2p-net'}),/TransportAdapter/);
 assert.throws(()=>assertTransportAdapter({}),/implement send/);
});
