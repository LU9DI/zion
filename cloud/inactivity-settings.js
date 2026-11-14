/* Local-only settings model for the Zion Cloud preview. This does not configure a node. */
(function (root) {
  'use strict';
  const KEY = 'zion.cloud.preview.inactivity-settings.v1';
  const defaults = Object.freeze({ pauseWarningAtDays: 7, pauseAfterDays: 14, reductionWarningAtDays: 30, reduceAfterDays: 37, reductionPercent: 50 });
  function validate(input) {
    const value = {};
    for (const key of Object.keys(defaults)) {
      const n = Number(input?.[key]);
      if (!Number.isInteger(n)) return { ok: false, error: 'Fill in every field with a whole number.' };
      value[key] = n;
    }
    if (value.pauseWarningAtDays < 1 || value.pauseWarningAtDays >= value.pauseAfterDays || value.pauseAfterDays > 365) {
      return { ok: false, error: 'The pause warning must occur at least 1 day before the pause and within 365 days.' };
    }
    if (value.reductionWarningAtDays <= value.pauseAfterDays || value.reductionWarningAtDays >= value.reduceAfterDays || value.reduceAfterDays > 730) {
      return { ok: false, error: 'The reduction warning must occur after the pause and before the reduction (maximum: 730 days).' };
    }
    if (value.reductionPercent < 1 || value.reductionPercent > 90) {
      return { ok: false, error: 'The reduction must be between 1% and 90% of contributed capacity.' };
    }
    return { ok: true, value: Object.freeze(value) };
  }
  function load(storage) {
    let raw;
    try { raw = storage?.getItem(KEY); }
    catch { return { ...defaults, persistence: 'storage-unavailable' }; }
    if (!raw) return { ...defaults, persistence: 'default' };
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return { ...defaults, persistence: 'invalid-reset' }; }
    const result = validate(parsed);
    return result.ok ? { ...result.value, persistence: 'saved-local' } : { ...defaults, persistence: 'invalid-reset' };
  }
  function save(storage, input) {
    const result = validate(input);
    if (!result.ok) return result;
    try {
      if (!storage || typeof storage.setItem !== 'function') throw new Error('Storage unavailable');
      storage.setItem(KEY, JSON.stringify(result.value));
      return { ok: true, value: result.value, persistence: 'saved-local' };
    } catch { return { ok: false, error: 'Could not save in this browser. Check your storage permissions.' }; }
  }
  function preview(input) {
    const result = validate(input);
    if (!result.ok) return result;
    const s = result.value;
    return { ok: true, pauseWarningAtDays: s.pauseWarningAtDays, pauseAfterDays: s.pauseAfterDays,
      reductionWarningAtDays: s.reductionWarningAtDays, reduceAfterDays: s.reduceAfterDays,
      daysBetweenReductionWarningAndAction: s.reduceAfterDays - s.reductionWarningAtDays,
      reductionPercent: s.reductionPercent, remainingCapacityPercent: 100 - s.reductionPercent,
      note: 'Local preview: these deadlines will only apply to a node when a backend is connected.' };
  }
  root.ZionInactivitySettings = Object.freeze({ KEY, defaults, validate, load, save, preview });
})(typeof window !== 'undefined' ? window : globalThis);
