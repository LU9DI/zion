import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
const defaults = Object.freeze({
  warningBeforePauseMs: 7 * DAY,
  pauseAfterMs: 14 * DAY,
  reductionNoticeBeforeMs: 7 * DAY,
  reduceAfterMs: 37 * DAY,
  reductionFactor: 0.5,
});

function validateOptions(options) {
  const out = { ...defaults, ...options };
  for (const key of ['warningBeforePauseMs', 'pauseAfterMs', 'reductionNoticeBeforeMs', 'reduceAfterMs']) {
    if (!Number.isSafeInteger(out[key]) || out[key] < DAY) throw new RangeError(`Invalid inactivity duration: ${key}`);
  }
  if (out.warningBeforePauseMs >= out.pauseAfterMs || out.reductionNoticeBeforeMs >= out.reduceAfterMs || out.pauseAfterMs >= out.reduceAfterMs) {
    throw new RangeError('Inactivity thresholds must be ordered: warning, pause, reduction notice, reduction');
  }
  if (!Number.isFinite(out.reductionFactor) || out.reductionFactor <= 0 || out.reductionFactor >= 1) throw new RangeError('reductionFactor must be between 0 and 1');
  return Object.freeze(out);
}

/**
 * Inactivity policy for contributed resources. It never deletes user data or evicts
 * replicas directly. Capacity can be reduced only after the caller confirms that
 * occupied bytes fit the new offer, or a migration callback proves safe relocation.
 *
 * Callbacks: notify(event), pauseContribution(reason), resumeContribution(),
 * getCapacity(), setCapacity(bytes), getUsage(), migrateReplicas({targetBytes, usedBytes}).
 */
export class InactivityResourcePolicy {
  constructor({ statePath, options = {}, now = () => Date.now(), notify = () => {}, pauseContribution = async () => {}, resumeContribution = async () => {}, getCapacity, setCapacity = async () => {}, getUsage, migrateReplicas = async () => false } = {}) {
    if (typeof statePath !== 'string' || !statePath.trim() || typeof now !== 'function' || typeof notify !== 'function' ||
      typeof pauseContribution !== 'function' || typeof resumeContribution !== 'function' || typeof getCapacity !== 'function' ||
      typeof setCapacity !== 'function' || typeof getUsage !== 'function' || typeof migrateReplicas !== 'function') {
      throw new TypeError('Invalid inactivity policy configuration');
    }
    this.statePath = resolve(statePath);
    this.options = validateOptions(options);
    this.now = now;
    this.callbacks = { notify, pauseContribution, resumeContribution, getCapacity, setCapacity, getUsage, migrateReplicas };
    this.state = this.#load();
  }

  markActivity(at = this.now()) {
    if (!Number.isSafeInteger(at) || at < 0 || at > this.now() + 60_000) throw new TypeError('Invalid activity timestamp');
    const wasPaused = this.state.pauseApplied;
    const wasReduced = this.state.capacityReduced;
    const originalCapacityBytes = this.state.originalCapacityBytes;
    return (async () => {
      if (wasPaused) await this.callbacks.resumeContribution();
      if (wasReduced && Number.isSafeInteger(originalCapacityBytes)) await this.callbacks.setCapacity(originalCapacityBytes);
      this.state = { version: 1, lastActivityAt: at, pauseWarningSent: false, pauseApplied: false,
        reductionNoticeSent: false, capacityReduced: false, reductionPending: false, originalCapacityBytes: null };
      this.#save();
      return Object.freeze({ ok: true, resumed: wasPaused, capacityRestoreRequested: wasReduced, lastActivityAt: at });
    })();
  }

  async evaluate(at = this.now()) {
    if (!Number.isSafeInteger(at) || at < this.state.lastActivityAt) throw new TypeError('Invalid evaluation timestamp');
    const idleMs = at - this.state.lastActivityAt;
    // Each evaluation uses one immutable options snapshot even if settings are
    // refreshed while an awaited storage/notification callback is in flight.
    const options = this.options;
    const events = [];
    const emit = async event => { events.push(Object.freeze(event)); await this.callbacks.notify(Object.freeze(event)); };

    const pauseWarningAt = options.pauseAfterMs - options.warningBeforePauseMs;
    if (!this.state.pauseWarningSent && idleMs >= pauseWarningAt && idleMs < options.pauseAfterMs) {
      await emit({ type: 'pause-warning', idleMs, deadlineAt: this.state.lastActivityAt + options.pauseAfterMs,
        message: 'Seu dispositivo está inativo. A contribuição será pausada se a inatividade continuar.' });
      this.state.pauseWarningSent = true;
      this.#save();
    }
    if (!this.state.pauseApplied && idleMs >= options.pauseAfterMs) {
      await this.callbacks.pauseContribution('inactivity-policy');
      this.state.pauseApplied = true;
      this.#save();
      await emit({ type: 'contribution-paused', idleMs, message: 'A contribuição foi pausada por inatividade; seus arquivos pessoais permanecem intactos.' });
    }

    const reductionNoticeAt = options.reduceAfterMs - options.reductionNoticeBeforeMs;
    if (!this.state.reductionNoticeSent && idleMs >= reductionNoticeAt && idleMs < options.reduceAfterMs) {
      await emit({ type: 'capacity-reduction-warning', idleMs, deadlineAt: this.state.lastActivityAt + options.reduceAfterMs,
        message: 'Aviso: a capacidade que você oferece à rede poderá ser reduzida por inatividade. Nenhum arquivo será apagado automaticamente.' });
      this.state.reductionNoticeSent = true;
      this.#save();
    }
    if (!this.state.capacityReduced && idleMs >= options.reduceAfterMs) {
      const currentCapacity = await this.callbacks.getCapacity();
      let usage = await this.callbacks.getUsage();
      if (!Number.isSafeInteger(currentCapacity) || currentCapacity < 0 || !Number.isSafeInteger(usage) || usage < 0 || usage > currentCapacity) {
        this.state.reductionPending = true;
        this.#save();
        return Object.freeze({ ok: false, idleMs, events: Object.freeze(events), status: 'capacity-check-unavailable', dataDeleted: false });
      }
      const targetBytes = Math.floor(currentCapacity * options.reductionFactor);
      if (this.state.originalCapacityBytes === null) { this.state.originalCapacityBytes = currentCapacity; this.#save(); }
      let safeToReduce = usage <= targetBytes;
      if (!safeToReduce) {
        const migrationVerified = await this.callbacks.migrateReplicas({ targetBytes, usedBytes: usage }) === true;
        if (migrationVerified) {
          usage = await this.callbacks.getUsage();
          safeToReduce = Number.isSafeInteger(usage) && usage >= 0 && usage <= targetBytes;
        }
      }
      if (!safeToReduce || usage > targetBytes) {
        if (!this.state.reductionPending) await emit({ type: 'capacity-reduction-pending', targetBytes, usedBytes: usage,
          message: 'A redução está pendente: as réplicas precisam ser migradas com segurança. Nenhum dado foi removido.' });
        this.state.reductionPending = true;
        this.#save();
        return Object.freeze({ ok: false, idleMs, events: Object.freeze(events), status: 'safe-migration-required', targetBytes, usedBytes: usage, dataDeleted: false });
      }
      await this.callbacks.setCapacity(targetBytes);
      this.state.capacityReduced = true;
      this.state.reductionPending = false;
      this.#save();
      await emit({ type: 'capacity-reduced', previousCapacityBytes: currentCapacity, capacityBytes: targetBytes,
        message: 'A capacidade oferecida foi reduzida após o aviso prévio; nenhum dado foi apagado automaticamente.' });
    }
    return Object.freeze({ ok: true, idleMs, events: Object.freeze(events), status: this.state.capacityReduced ? 'capacity-reduced' : this.state.pauseApplied ? 'contribution-paused' : 'active-or-warning', dataDeleted: false });
  }

  updateOptions(options) {
    // Validate the complete replacement before mutating live policy configuration.
    const next = validateOptions(options);
    this.options = next;
    return Object.freeze({ ok: true, options: this.options });
  }

  snapshot() { return Object.freeze({ ...this.state, options: this.options }); }

  #load() {
    let stat;
    try { stat = lstatSync(this.statePath); }
    catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, lastActivityAt: this.now(), pauseWarningSent: false, pauseApplied: false, reductionNoticeSent: false, capacityReduced: false, reductionPending: false, originalCapacityBytes: null };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Inactivity state must be a regular non-symlink file');
    const value = JSON.parse(readFileSync(this.statePath, 'utf8'));
    if (value?.version !== 1 || !Number.isSafeInteger(value.lastActivityAt) || value.lastActivityAt < 0 ||
      ['pauseWarningSent', 'pauseApplied', 'reductionNoticeSent', 'capacityReduced', 'reductionPending'].some(k => typeof value[k] !== 'boolean') ||
      !(value.originalCapacityBytes === null || (Number.isSafeInteger(value.originalCapacityBytes) && value.originalCapacityBytes >= 0))) {
      throw new Error('Invalid persisted inactivity state');
    }
    return value;
  }

  #save() {
    const directory = dirname(this.statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(this.state)}\n`, 'utf8');
      fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.statePath);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}

export const INACTIVITY_POLICY_DEFAULTS = Object.freeze({ ...defaults });
