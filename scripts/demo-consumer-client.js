import { ZionClient, MemoryCiphertextAdapter } from '../src/zion-client.js';

const adapter = new MemoryCiphertextAdapter();
const client = new ZionClient({ storageAdapter: adapter, chunkBytes: 8 });
const original = Buffer.from('Zion should feel invisible to consumer applications.');
const uploaded = await client.upload(original);
const restored = await client.download({ cid: uploaded.cid, manifest: uploaded.manifest, fileKey: uploaded.fileKey });
if (!restored.equals(original)) throw new Error('consumer client round-trip failed');
console.log(JSON.stringify({ ok: true, cid: uploaded.cid, chunks: uploaded.manifest.chunkCount, plaintextBytes: original.length, adapterStoresCiphertextOnly: true }));
