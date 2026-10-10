import { verifyStoreReceipt } from './replication-receipts.js';

const ID=/^[a-f0-9]{64}$/;
/**
 * Local, bounded reputation derived only from cryptographically verified receipts and
 * externally authenticated audit outcomes. It is a ranking signal, never proof of identity uniqueness.
 */
export class PeerReputation {
  constructor({ now=()=>Date.now(), maxEvents=100_000, receiptWeight=1, successWeight=2, failurePenalty=5 }={}) {
    if(typeof now!=='function'||![maxEvents].every(n=>Number.isSafeInteger(n)&&n>0)||
      ![receiptWeight,successWeight,failurePenalty].every(n=>Number.isFinite(n)&&n>=0&&n<=100))throw new TypeError('Invalid reputation configuration');
    this.now=now;this.maxEvents=maxEvents;this.weights={receiptWeight,successWeight,failurePenalty};this.events=[];
  }
  recordReceipt({message, request}) {
    const result=verifyStoreReceipt(message,request,{now:this.now()});
    if(!result.ok)return result;
    if(this.events.length>=this.maxEvents)return {ok:false,reason:'event-capacity-reached'};
    this.events.push(Object.freeze({nodeId:result.nodeId,type:'receipt',at:this.now(),weight:this.weights.receiptWeight, evidenceId:request.requestId}));
    return {ok:true,nodeId:result.nodeId};
  }
  recordAuditOutcome({nodeId, outcome, evidenceId, authenticated=false}) {
    if(!authenticated)return {ok:false,reason:'unauthenticated-audit-outcome'};
    if(!ID.test(nodeId??'')||!['success','failure'].includes(outcome)||typeof evidenceId!=='string'||evidenceId.length<1||evidenceId.length>256)
      return {ok:false,reason:'invalid-audit-outcome'};
    if(this.events.length>=this.maxEvents)return {ok:false,reason:'event-capacity-reached'};
    if(this.events.some(e=>e.type==='audit'&&e.evidenceId===evidenceId))return {ok:false,reason:'duplicate-audit-evidence'};
    this.events.push(Object.freeze({nodeId,type:'audit',outcome,at:this.now(),weight:outcome==='success'?this.weights.successWeight:-this.weights.failurePenalty,evidenceId}));
    return {ok:true,nodeId};
  }
  score(nodeId) { if(!ID.test(nodeId??''))throw new TypeError('Invalid node ID'); return this.events.filter(e=>e.nodeId===nodeId).reduce((s,e)=>s+e.weight,0); }
  summary(nodeId) { const events=this.events.filter(e=>e.nodeId===nodeId); return Object.freeze({nodeId,score:this.score(nodeId),verifiedReceipts:events.filter(e=>e.type==='receipt').length,auditSuccesses:events.filter(e=>e.type==='audit'&&e.outcome==='success').length,auditFailures:events.filter(e=>e.type==='audit'&&e.outcome==='failure').length}); }
}
