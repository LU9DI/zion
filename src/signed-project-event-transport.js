import { randomBytes } from 'node:crypto';
import { verifySignedProjectEventRecord } from './signed-project-event-log.js';

/**
 * Attach a one-hop, authenticated transport adapter to the durable replica journal.
 * The transport authenticates the sender; the record verifier authenticates its
 * origin. Relaying another node's event is deliberately rejected in this first version.
 */
export function createSignedProjectEventReplicationHandler({ replica, transport, now = () => Date.now(), maxClockSkewMs = 120_000 } = {}) {
  if (!replica || typeof replica.ingest !== 'function' || !transport || typeof transport.send !== 'function' ||
      !transport.identity?.nodeId || typeof now !== 'function' ||
      !Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) {
    throw new TypeError('Invalid signed project event replication handler configuration');
  }
  return async (message, socket) => {
    if (message?.payload?.type !== 'PROJECT_EVENT_REPLICATION') return false;
    if (message.signal?.aborted || socket?.destroyed) return false;
    const { requestId, record } = message.payload;
    const checked = verifySignedProjectEventRecord(record, { now: now(), maxClockSkewMs });
    if (!checked.ok || checked.nodeId !== message.nodeId) {
      throw Object.assign(new Error('Replicated event signer must match the authenticated transport peer'), {
        code: 'ZION_REPLICATION_SENDER_MISMATCH',
      });
    }
    const result = await replica.ingest(record);
    if (message.signal?.aborted || socket?.destroyed) return false;
    transport.send(socket, {
      type: 'PROJECT_EVENT_REPLICATION_ACK',
      requestId,
      nodeId: result.nodeId,
      sequence: result.sequence,
      recordHash: result.recordHash,
      accepted: result.accepted,
      duplicate: result.duplicate,
    });
    return true;
  };
}

/** Send a local node's signed event record to one already-authenticated peer. */
export function sendSignedProjectEventRecord({ transport, socket, record, now = () => Date.now(), maxClockSkewMs = 120_000 } = {}) {
  if (!transport?.identity?.nodeId || typeof transport.send !== 'function' ||
      !socket || socket.destroyed || typeof now !== 'function') {
    throw new TypeError('Invalid signed project event replication send configuration');
  }
  const checked = verifySignedProjectEventRecord(record, { now: now(), maxClockSkewMs });
  if (!checked.ok || checked.nodeId !== transport.identity.nodeId) {
    throw Object.assign(new Error('Only locally signed event records may be sent by this transport'), {
      code: 'ZION_REPLICATION_LOCAL_SIGNER_MISMATCH',
    });
  }
  const requestId = randomBytes(16).toString('hex');
  transport.send(socket, { type: 'PROJECT_EVENT_REPLICATION', requestId, record });
  return requestId;
}
