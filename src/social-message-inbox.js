import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_ID_LENGTH = 128;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function nonEmpty(value, field, max = MAX_ID_LENGTH) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function validateEnvelope(envelope, now, maxTtlMs) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('envelope must be an object');
  if (envelope.version !== 1) throw new TypeError('unsupported envelope version');
  nonEmpty(envelope.id, 'envelope.id');
  nonEmpty(envelope.senderId, 'envelope.senderId');
  nonEmpty(envelope.recipientId, 'envelope.recipientId');
  nonEmpty(envelope.ciphertext, 'envelope.ciphertext', MAX_ENVELOPE_BYTES);
  nonEmpty(envelope.signature, 'envelope.signature', 8192);
  if (!Number.isSafeInteger(envelope.createdAt) || envelope.createdAt < 0 || envelope.createdAt > now + 120_000 || now - envelope.createdAt > maxTtlMs) {
    throw new TypeError('envelope timestamp is outside the accepted window');
  }
  const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (bytes > MAX_ENVELOPE_BYTES) throw new RangeError('encrypted envelope exceeds the maximum size');
  return bytes;
}

/**
 * Durable, bounded queue for opaque encrypted envelopes. This is a storage primitive,
 * not a network listener or an authenticated delivery service. Callers must authenticate
 * peers and verify envelope signatures before acknowledging delivery to an application.
 */
export class SocialMessageInbox {
  #records = [];
  #loaded = false;
  #writeChain = Promise.resolve();

  constructor({ filePath, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxMessages = 10_000, maxPerRecipient = 500, maxBytes = 64 * 1024 * 1024 } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('filePath is required');
    if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || !Number.isSafeInteger(maxPerRecipient) || maxPerRecipient < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < MAX_ENVELOPE_BYTES) throw new RangeError('invalid inbox limits');
    this.filePath = resolve(filePath);
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.maxPerRecipient = maxPerRecipient;
    this.maxBytes = maxBytes;
  }

  async init() {
    if (this.#loaded) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.records)) throw new Error('invalid inbox store schema');
      const now = this.now();
      for (const record of parsed.records) {
        if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.queuedAt) || !record.envelope) throw new Error('invalid inbox record');
      }
      this.#records = parsed.records.filter(record => record.queuedAt >= now - this.ttlMs && Number.isSafeInteger(record.envelope?.createdAt) && record.envelope.createdAt >= now - this.ttlMs);
      for (const record of this.#records) validateEnvelope(record.envelope, now, this.ttlMs);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Unable to load social inbox: ${error.message}`);
    }
    this.#loaded = true;
    await this.#pruneAndPersist();
    return this;
  }

  async enqueue(envelope) {
    await this.init();
    validateEnvelope(envelope, this.now(), this.ttlMs);
    return this.#mutate(() => {
      const duplicate = this.#records.find(r => r.envelope.senderId === envelope.senderId && r.envelope.id === envelope.id);
      if (duplicate) return { accepted: true, duplicate: true, queuedAt: duplicate.queuedAt };
      const recipientCount = this.#records.filter(r => r.envelope.recipientId === envelope.recipientId).length;
      if (this.#records.length >= this.maxMessages) throw new Error('inbox capacity reached');
      if (recipientCount >= this.maxPerRecipient) throw new Error('recipient inbox capacity reached');
      const record = { queueId: randomBytes(16).toString('hex'), queuedAt: this.now(), envelope: structuredClone(envelope) };
      this.#records.push(record);
      if (this.#serializedBytes() > this.maxBytes) {
        this.#records.pop();
        throw new Error('inbox storage quota reached');
      }
      return { accepted: true, duplicate: false, queuedAt: record.queuedAt };
    });
  }

  async list(recipientId, { limit = 100, after = 0 } = {}) {
    await this.init();
    nonEmpty(recipientId, 'recipientId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(after) || after < 0) throw new RangeError('invalid inbox query limits');
    await this.#mutate(() => ({ accepted: true }));
    return this.#records.filter(r => r.envelope.recipientId === recipientId && r.queuedAt > after)
      .sort((a, b) => a.queuedAt - b.queuedAt || a.queueId.localeCompare(b.queueId))
      .slice(0, limit).map(r => Object.freeze({ queueId: r.queueId, queuedAt: r.queuedAt, envelope: structuredClone(r.envelope) }));
  }

  async acknowledge(recipientId, queueIds) {
    await this.init();
    nonEmpty(recipientId, 'recipientId');
    if (!Array.isArray(queueIds) || queueIds.length < 1 || queueIds.length > 500 || queueIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id))) throw new TypeError('queueIds must contain 1 to 500 valid queue identifiers');
    return this.#mutate(() => {
      const ids = new Set(queueIds);
      const before = this.#records.length;
      this.#records = this.#records.filter(r => !(r.envelope.recipientId === recipientId && ids.has(r.queueId)));
      return { acknowledged: before - this.#records.length };
    });
  }

  async stats() {
    await this.init();
    return Object.freeze({ messages: this.#records.length, recipients: new Set(this.#records.map(r => r.envelope.recipientId)).size, bytes: this.#serializedBytes() });
  }

  #mutate(operation) {
    const task = this.#writeChain.then(async () => {
      await this.#prune();
      const result = operation();
      await this.#persist();
      return result;
    });
    this.#writeChain = task.catch(() => {});
    return task;
  }

  async #prune() {
    const cutoff = this.now() - this.ttlMs;
    this.#records = this.#records.filter(r => r.queuedAt >= cutoff && r.envelope.createdAt >= cutoff);
  }
  async #pruneAndPersist() { await this.#prune(); await this.#persist(); }
  #serializedBytes() { return Buffer.byteLength(JSON.stringify({ schema: 1, records: this.#records }), 'utf8'); }
  async #persist() {
    const temp = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify({ schema: 1, records: this.#records }), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.filePath);
  }
}
