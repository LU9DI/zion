import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const sha = b => createHash('sha256').update(b).digest();
const hex = b => b.toString('hex');
const leafHash = (index, bytes) => sha(Buffer.concat([Buffer.from([0]), Buffer.from(String(index)), Buffer.from([0]), bytes]));
const parentHash = (left, right) => sha(Buffer.concat([Buffer.from([1]), left, right]));
function treeFor(data, leafSize) {
  if (!Buffer.isBuffer(data) || data.length < 1) throw new TypeError('data must be a non-empty Buffer');
  if (!Number.isSafeInteger(leafSize) || leafSize < 256 || leafSize > 64 * 1024) throw new RangeError('leafSize must be 256..65536 bytes');
  const leaves = [];
  for (let offset=0, index=0; offset<data.length; offset+=leafSize,index++) leaves.push(leafHash(index,data.subarray(offset,Math.min(offset+leafSize,data.length))));
  const levels=[leaves];
  while(levels.at(-1).length>1) {
    const prev=levels.at(-1), next=[];
    for(let i=0;i<prev.length;i+=2) next.push(parentHash(prev[i],prev[i+1] ?? prev[i]));
    levels.push(next);
  }
  return { leaves, levels, root:hex(levels.at(-1)[0]) };
}
export function createStorageCommitment(data, { leafSize = 4096 } = {}) {
  const tree=treeFor(data,leafSize);
  return Object.freeze({ version:1, root:tree.root, byteLength:data.length, leafSize, leafCount:tree.leaves.length });
}
export function createStorageChallenge({ commitment, sampleCount = 3, challengeId = randomBytes(16).toString('hex') } = {}) {
  if (!commitment || commitment.version!==1 || !HASH.test(commitment.root ?? '') ||
      !Number.isSafeInteger(commitment.leafCount) || commitment.leafCount<1 ||
      !Number.isSafeInteger(commitment.leafSize) || commitment.leafSize<256 || commitment.leafSize>65536 ||
      !Number.isSafeInteger(commitment.byteLength) || commitment.byteLength<1 ||
      !Number.isSafeInteger(sampleCount) || sampleCount<1 || sampleCount>16 ||
      typeof challengeId!=='string' || !/^[a-f0-9]{32}$/.test(challengeId)) throw new TypeError('Invalid storage challenge');
  const indices=new Set();
  const seed=randomBytes(32);
  while(indices.size<Math.min(sampleCount,commitment.leafCount)) {
    const n=sha(Buffer.concat([seed,Buffer.from(String(indices.size)),Buffer.from(challengeId)]));
    indices.add(Number(n.readUInt32BE(0))%commitment.leafCount);
  }
  return Object.freeze({ version:1, challengeId, root:commitment.root, byteLength:commitment.byteLength, leafSize:commitment.leafSize,
    leafCount:commitment.leafCount, indices:Object.freeze([...indices].sort((a,b)=>a-b)) });
}
export function answerStorageChallenge(data, challenge) {
  if (!challenge || !Array.isArray(challenge.indices) || challenge.indices.length<1 || challenge.indices.length>16) throw new TypeError('Invalid storage challenge');
  const tree=treeFor(data,challenge.leafSize);
  if (tree.root!==challenge.root || data.length!==challenge.byteLength || tree.leaves.length!==challenge.leafCount) throw Object.assign(new Error('Stored data does not match commitment'),{code:'ZION_STORAGE_COMMITMENT_MISMATCH'});
  const samples=challenge.indices.map(index=>{
    if(!Number.isSafeInteger(index)||index<0||index>=tree.leaves.length) throw new TypeError('Invalid sample index');
    let position=index;
    const proof=[];
    for(let level=0;level<tree.levels.length-1;level++){
      const nodes=tree.levels[level], sibling=position^1;
      proof.push({ side:(position%2===0?'right':'left'), hash:hex(nodes[sibling] ?? nodes[position]) });
      position=Math.floor(position/2);
    }
    const start=index*challenge.leafSize;
    return Object.freeze({ index, bytes:data.subarray(start,Math.min(start+challenge.leafSize,data.length)).toString('base64'), proof:Object.freeze(proof) });
  });
  return Object.freeze({ version:1, challengeId:challenge.challengeId, root:challenge.root, samples:Object.freeze(samples) });
}
export function verifyStorageChallengeResponse({ challenge, response, maxResponseBytes = 1_100_000 } = {}) {
  const fail=reason=>({ok:false,reason});
  if(!challenge||!response||challenge.version!==1||response.version!==1||response.challengeId!==challenge.challengeId||
    response.root!==challenge.root||!HASH.test(challenge.root??'')||!Array.isArray(challenge.indices)||!Array.isArray(response.samples)||
    response.samples.length!==challenge.indices.length||response.samples.length>16) return fail('challenge-mismatch');
  let total=0;
  const seen=new Set();
  for(const sample of response.samples){
    if(!Number.isSafeInteger(sample.index)||!challenge.indices.includes(sample.index)||seen.has(sample.index)||typeof sample.bytes!=='string'||!Array.isArray(sample.proof))return fail('invalid-sample');
    seen.add(sample.index);
    let bytes;
    try{bytes=Buffer.from(sample.bytes,'base64');}catch{return fail('invalid-sample-bytes');}
    total+=bytes.length;
    if(total>maxResponseBytes)return fail('response-too-large');
    const expectedLength=sample.index===challenge.leafCount-1 ? challenge.byteLength-sample.index*challenge.leafSize : challenge.leafSize;
    if(bytes.length!==expectedLength)return fail('sample-length-mismatch');
    let hash=leafHash(sample.index,bytes);
    let position=sample.index;
    let levelCount=challenge.leafCount;
    for(const step of sample.proof){
      if(!step||!['left','right'].includes(step.side)||!HASH.test(step.hash??''))return fail('invalid-merkle-proof');
      const sibling=Buffer.from(step.hash,'hex');
      if(step.side===(position%2===0?'left':'right'))return fail('invalid-merkle-direction');
      hash=step.side==='left'?parentHash(sibling,hash):parentHash(hash,sibling);
      position=Math.floor(position/2);levelCount=Math.ceil(levelCount/2);
    }
    if(levelCount!==1||!timingSafeEqual(hash,Buffer.from(challenge.root,'hex')))return fail('merkle-root-mismatch');
  }
  if(seen.size!==challenge.indices.length)return fail('missing-samples');
  return Object.freeze({ok:true,verifiedSamples:seen.size,challengeId:challenge.challengeId});
}
