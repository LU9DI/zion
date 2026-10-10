import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
export const DEFAULT_INACTIVITY_SETTINGS = Object.freeze({
  pauseWarningAtDays: 7,
  pauseAfterDays: 14,
  reductionWarningAtDays: 30,
  reduceAfterDays: 37,
  reductionPercent: 50,
});

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('settings must be an object');
  const settings = {};
  for (const key of Object.keys(DEFAULT_INACTIVITY_SETTINGS)) {
    if (!Object.hasOwn(input, key) || !Number.isSafeInteger(input[key])) throw new TypeError(`Invalid setting: ${key}`);
    settings[key] = input[key];
  }
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_INACTIVITY_SETTINGS, key))) throw new TypeError('Unknown inactivity setting');
  if (settings.pauseWarningAtDays < 1 || settings.pauseAfterDays > 365 || settings.pauseWarningAtDays >= settings.pauseAfterDays ||
      settings.reductionWarningAtDays < 1 || settings.reduceAfterDays > 730 || settings.reductionWarningAtDays >= settings.reduceAfterDays ||
      settings.pauseAfterDays >= settings.reduceAfterDays || settings.reductionPercent < 1 || settings.reductionPercent > 90) {
    throw new RangeError('Inactivity settings are outside allowed limits or thresholds are not ordered');
  }
  return Object.freeze(settings);
}

function safeIdentityId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Authenticated per-identity inactivity settings. This service is transport-neutral:
 * a host API must pass the Bearer token and return its results over TLS. It stores
 * no bearer tokens and never claims that settings are applied to a running node.
 */
export class InactivitySettingsService {
  #queue = Promise.resolve();

  constructor({ sessionAuthority, statePath, now = () => Date.now() } = {}) {
    if (!sessionAuthority || typeof sessionAuthority.authenticateToken !== 'function' || typeof statePath !== 'string' || !statePath.trim() || typeof now !== 'function') {
      throw new TypeError('Invalid inactivity settings service configuration');
    }
    this.sessionAuthority = sessionAuthority;
    this.statePath = resolve(statePath);
    this.now = now;
  }

  async getSettings(bearerToken) {
    const identityId = this.#authenticate(bearerToken);
    return this.#exclusive(() => {
      const state = this.#load();
      return Object.freeze({ ok: true, identityId, settings: state.settings[identityId] || DEFAULT_INACTIVITY_SETTINGS,
        source: state.settings[identityId] ? 'account' : 'defaults', appliedToNode: false });
    });
  }

  async updateSettings(bearerToken, input) {
    const identityId = this.#authenticate(bearerToken);
    const settings = validateSettings(input);
    return this.#exclusive(() => {
      const state = this.#load();
      state.settings[identityId] = settings;
      state.updatedAt[identityId] = this.now();
      this.#save(state);
      return Object.freeze({ ok: true, identityId, settings, updatedAt: state.updatedAt[identityId], source: 'account', appliedToNode: false });
    });
  }

  async resetSettings(bearerToken) {
    const identityId = this.#authenticate(bearerToken);
    return this.#exclusive(() => {
      const state = this.#load();
      delete state.settings[identityId];
      delete state.updatedAt[identityId];
      this.#save(state);
      return Object.freeze({ ok: true, identityId, settings: DEFAULT_INACTIVITY_SETTINGS, source: 'defaults', appliedToNode: false });
    });
  }

  #authenticate(token) {
    const session = this.sessionAuthority.authenticateToken(token);
    if (!session || !safeIdentityId(session.identityId)) throw Object.assign(new Error('Authentication required'), { code: 'UNAUTHENTICATED', status: 401 });
    return session.identityId;
  }

  #exclusive(operation) {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #load() {
    let stat;
    try { stat = lstatSync(this.statePath); }
    catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, settings: Object.create(null), updatedAt: Object.create(null) };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Inactivity settings state must be a regular non-symlink file');
    const state = JSON.parse(readFileSync(this.statePath, 'utf8'));
    if (state?.version !== 1 || !state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings) ||
      !state.updatedAt || typeof state.updatedAt !== 'object' || Array.isArray(state.updatedAt)) throw new Error('Invalid persisted inactivity settings');
    const cleanSettings = Object.create(null), cleanUpdatedAt = Object.create(null);
    for (const [identityId, settings] of Object.entries(state.settings)) {
      if (!safeIdentityId(identityId)) throw new Error('Invalid identity in inactivity settings');
      cleanSettings[identityId] = validateSettings(settings);
    }
    for (const [identityId, timestamp] of Object.entries(state.updatedAt)) {
      if (!safeIdentityId(identityId) || !Number.isSafeInteger(timestamp) || timestamp < 0 || !Object.hasOwn(cleanSettings, identityId)) throw new Error('Invalid inactivity settings timestamp');
      cleanUpdatedAt[identityId] = timestamp;
    }
    return { version: 1, settings: cleanSettings, updatedAt: cleanUpdatedAt };
  }

  #save(state) {
    const directory = dirname(this.statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf8');
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.statePath);
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      try { unlinkSync(temp); } catch {}
      throw error;
    }
  }
}

export function inactivitySettingsToPolicyOptions(settingsInput) {
  const settings = validateSettings(settingsInput);
  return Object.freeze({
    warningBeforePauseMs: (settings.pauseAfterDays - settings.pauseWarningAtDays) * DAY,
    pauseAfterMs: settings.pauseAfterDays * DAY,
    reductionNoticeBeforeMs: (settings.reduceAfterDays - settings.reductionWarningAtDays) * DAY,
    reduceAfterMs: settings.reduceAfterDays * DAY,
    reductionFactor: 1 - settings.reductionPercent / 100,
  });
}
