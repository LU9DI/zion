/* Local-only settings model for the Zion Cloud preview. This does not configure a node. */
(function (root) {
  'use strict';
  const KEY = 'zion.cloud.preview.inactivity-settings.v1';
  const defaults = Object.freeze({ pauseWarningAtDays: 7, pauseAfterDays: 14, reductionWarningAtDays: 30, reduceAfterDays: 37, reductionPercent: 50 });
  function validate(input) {
    const value = {};
    for (const key of Object.keys(defaults)) {
      const n = Number(input?.[key]);
      if (!Number.isInteger(n)) return { ok: false, error: 'Preencha todos os campos com números inteiros.' };
      value[key] = n;
    }
    if (value.pauseWarningAtDays < 1 || value.pauseWarningAtDays >= value.pauseAfterDays || value.pauseAfterDays > 365) {
      return { ok: false, error: 'O aviso da pausa deve ocorrer pelo menos 1 dia antes da pausa, em até 365 dias.' };
    }
    if (value.reductionWarningAtDays <= value.pauseAfterDays || value.reductionWarningAtDays >= value.reduceAfterDays || value.reduceAfterDays > 730) {
      return { ok: false, error: 'O aviso de redução deve vir depois da pausa e antes da redução (máximo: 730 dias).' };
    }
    if (value.reductionPercent < 1 || value.reductionPercent > 90) {
      return { ok: false, error: 'A redução deve ficar entre 1% e 90% da capacidade oferecida.' };
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
    } catch { return { ok: false, error: 'Não foi possível salvar no navegador. Verifique as permissões de armazenamento.' }; }
  }
  function preview(input) {
    const result = validate(input);
    if (!result.ok) return result;
    const s = result.value;
    return { ok: true, pauseWarningAtDays: s.pauseWarningAtDays, pauseAfterDays: s.pauseAfterDays,
      reductionWarningAtDays: s.reductionWarningAtDays, reduceAfterDays: s.reduceAfterDays,
      daysBetweenReductionWarningAndAction: s.reduceAfterDays - s.reductionWarningAtDays,
      reductionPercent: s.reductionPercent, remainingCapacityPercent: 100 - s.reductionPercent,
      note: 'Simulação local: os prazos só serão aplicados a um nó quando houver backend conectado.' };
  }
  root.ZionInactivitySettings = Object.freeze({ KEY, defaults, validate, load, save, preview });
})(typeof window !== 'undefined' ? window : globalThis);
