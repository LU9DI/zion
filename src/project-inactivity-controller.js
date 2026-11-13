import { randomUUID } from 'node:crypto';

const DAY_MS = 86_400_000;
const PAUSE_AFTER_MS = 7 * DAY_MS;
const RELEASE_AFTER_MS = 15 * DAY_MS;
const MEANINGFUL_TYPES = new Set([
  'upload_committed',
  'file_replaced',
  'download_completed',
  'restore_completed',
  'configuration_committed',
  'source_change_committed',
  'user_operation_committed',
]);
const NON_MEANINGFUL_TYPES = new Set([
  'health_check', 'ping', 'heartbeat', 'telemetry', 'replication',
  'garbage_collection', 'malware_scan', 'notification', 'quota_check',
  'dashboard_poll', 'scheduler', 'billing', 'retry', 'keepalive',
]);

function assertId(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * Project-scoped inactivity lifecycle.
 *
 * Repository contract:
 *   withProjectLock(projectId, async tx => ...)
 *   tx.getProject(projectId)
 *   tx.recordActivity(event) -> boolean (true only when inserted)
 *   tx.updateLastMeaningfulActivity(projectId, at)
 *   tx.pauseProject(projectId, at)
 *   tx.markStorageReleasePending(projectId, at)
 *   tx.cancelStorageReleasePending(projectId)
 *   tx.listLiveStorageLeases(projectId)
 *   tx.markStorageLeasesReleased(projectId, leaseIds, at)
 *   tx.markProjectStorageReleased(projectId, at)
 *   tx.recordResourceEvent(event)
 *
 * Storage contract:
 *   relocateAndVerify({ project, leases }) -> true only after independently
 *     verifying every required replica, digest, byte count and durability receipt.
 *   releaseCapacity({ project, leases }) -> true only after each reservation is
 *     actually returned to the contributing node's available capacity.
 *
 * The controller never deletes user data. A false/throwing adapter result leaves
 * the project restricted and its reservation intact.
 */
export class ProjectInactivityController {
  constructor({ repository, storage, now = () => Date.now(), id = randomUUID } = {}) {
    if (!repository || typeof repository.withProjectLock !== 'function' ||
        !storage || typeof storage.relocateAndVerify !== 'function' ||
        typeof storage.releaseCapacity !== 'function' ||
        typeof now !== 'function' || typeof id !== 'function') {
      throw new TypeError('Invalid project inactivity controller configuration');
    }
    this.repository = repository;
    this.storage = storage;
    this.now = now;
    this.id = id;
  }

  async recordMeaningfulActivity({ projectId, actorId, actorKind, activityType, idempotencyKey }) {
    assertId(projectId, 'projectId');
    assertId(actorId, 'actorId');
    assertId(idempotencyKey, 'idempotencyKey');
    if (!['owner', 'collaborator'].includes(actorKind)) throw new TypeError('Invalid actorKind');
    const at = this.now();
    if (!MEANINGFUL_TYPES.has(activityType)) {
      if (NON_MEANINGFUL_TYPES.has(activityType)) return Object.freeze({ accepted: false, reason: 'non-meaningful-activity' });
      throw new TypeError('Unsupported activityType');
    }
    if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Invalid server activity timestamp');

    return this.repository.withProjectLock(projectId, async tx => {
      const project = await tx.getProject(projectId);
      if (!project) throw new Error('Project not found');
      if (project.lifecycleStatus === 'storage_released') {
        return Object.freeze({ accepted: false, reason: 'storage-already-released', reactivationRequired: true });
      }
      const event = {
        eventId: this.id(), projectId, actorId, actorKind, activityType,
        idempotencyKey, recordedAt: at,
      };
      const inserted = await tx.recordActivity(event);
      if (!inserted) return Object.freeze({ accepted: false, reason: 'duplicate-event' });
      await tx.updateLastMeaningfulActivity(projectId, at);
      if (project.lifecycleStatus === 'storage_release_pending') {
        await tx.cancelStorageReleasePending(projectId);
      }
      return Object.freeze({ accepted: true, projectId, lastMeaningfulActivityAt: at });
    });
  }

  async evaluateProject(projectId) {
    assertId(projectId, 'projectId');
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Invalid controller clock');

    const decision = await this.repository.withProjectLock(projectId, async tx => {
      const project = await tx.getProject(projectId);
      if (!project) return { status: 'not-found' };
      const lastActivity = Date.parse(project.lastMeaningfulActivityAt);
      if (!Number.isFinite(lastActivity) || lastActivity > at) {
        return { status: 'activity-state-unavailable' };
      }
      const idleMs = at - lastActivity;
      if (idleMs < PAUSE_AFTER_MS) return { status: 'active', idleMs };

      if (idleMs >= RELEASE_AFTER_MS) {
        if (project.lifecycleStatus !== 'storage_release_pending' &&
            project.lifecycleStatus !== 'storage_released') {
          if (project.lifecycleStatus !== 'paused') {
            await tx.pauseProject(projectId, at);
            await tx.recordResourceEvent({
              eventId: this.id(), projectId, eventType: 'project_paused',
              policyVersion: 1, recordedAt: at,
            });
          }
          await tx.markStorageReleasePending(projectId, at);
          await tx.recordResourceEvent({
            eventId: this.id(), projectId, eventType: 'storage_release_pending',
            policyVersion: 1, recordedAt: at,
          });
        }
        if (project.lifecycleStatus === 'storage_released') return { status: 'storage-released', idleMs };
        const leases = await tx.listLiveStorageLeases(projectId);
        return { status: 'release-required', idleMs, project, leases, activityAt: project.lastMeaningfulActivityAt };
      }

      if (project.lifecycleStatus === 'active') {
        await tx.pauseProject(projectId, at);
        await tx.recordResourceEvent({
          eventId: this.id(), projectId, eventType: 'project_paused',
          policyVersion: 1, recordedAt: at,
        });
        return { status: 'paused', idleMs };
      }
      return { status: project.lifecycleStatus, idleMs };
    });

    if (decision.status !== 'release-required') return Object.freeze(decision);
    if (!Array.isArray(decision.leases)) {
      return Object.freeze({ status: 'release-blocked', reason: 'lease-inventory-unavailable', dataDeleted: false });
    }

    let relocated = false;
    try {
      relocated = await this.storage.relocateAndVerify({
        project: decision.project,
        leases: decision.leases,
      }) === true;
    } catch {
      relocated = false;
    }
    if (!relocated) {
      return Object.freeze({ status: 'release-pending', reason: 'replica-relocation-or-verification-failed', dataDeleted: false });
    }

    // Re-acquire the project fence and re-check activity before freeing capacity.
    // Any newer valid activity cancels this stale release attempt.
    return this.repository.withProjectLock(projectId, async tx => {
      const current = await tx.getProject(projectId);
      if (!current || current.lifecycleStatus !== 'storage_release_pending' ||
          current.lastMeaningfulActivityAt !== decision.activityAt) {
        return Object.freeze({ status: 'release-aborted-stale-activity', dataDeleted: false });
      }
      const currentLeases = await tx.listLiveStorageLeases(projectId);
      if (!Array.isArray(currentLeases) ||
          currentLeases.map(x => x.leaseId).sort().join('|') !== decision.leases.map(x => x.leaseId).sort().join('|')) {
        return Object.freeze({ status: 'release-aborted-lease-set-changed', dataDeleted: false });
      }
      let released = false;
      try {
        released = await this.storage.releaseCapacity({ project: current, leases: currentLeases }) === true;
      } catch {
        released = false;
      }
      if (!released) return Object.freeze({ status: 'release-pending', reason: 'capacity-release-unconfirmed', dataDeleted: false });
      const releasedAt = this.now();
      await tx.markStorageLeasesReleased(projectId, currentLeases.map(x => x.leaseId), releasedAt);
      await tx.markProjectStorageReleased(projectId, releasedAt);
      await tx.recordResourceEvent({
        eventId: this.id(), projectId, eventType: 'storage_released',
        policyVersion: 1, recordedAt: releasedAt,
      });
      return Object.freeze({ status: 'storage-released', releasedLeases: currentLeases.length, dataDeleted: false });
    });
  }
}

export const PROJECT_INACTIVITY_POLICY = Object.freeze({
  pauseAfterMs: PAUSE_AFTER_MS,
  releaseAfterMs: RELEASE_AFTER_MS,
  pauseAfterDays: 7,
  releaseAfterDays: 15,
  meaningfulActivityTypes: Object.freeze([...MEANINGFUL_TYPES]),
});
