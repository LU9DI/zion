/* Optional authenticated API client for the Cloud preview. No credentials are stored here. */
(function (root) {
  'use strict';
  const ROUTE = '/api/v1/settings/inactivity';
  const MAX_TIMEOUT_MS = 10000;
  function create({ getAccessToken, fetchImpl, baseUrl = '', timeoutMs = 5000 } = {}) {
    if (typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('getAccessToken and fetchImpl are required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new RangeError('timeoutMs must be between 100 and 10000');
    const base = String(baseUrl).replace(/\/$/u, '');
    async function request(method, settings) {
      const token = await getAccessToken();
      if (typeof token !== 'string' || !token.trim()) throw Object.assign(new Error('Sessão autenticada indisponível.'), { code: 'AUTH_REQUIRED' });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer;
      try {
        if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetchImpl(base + ROUTE, {
          method,
          headers: { authorization: `Bearer ${token.trim()}`, accept: 'application/json', ...(settings ? { 'content-type': 'application/json' } : {}) },
          cache: 'no-store', credentials: 'omit', redirect: 'error',
          ...(controller ? { signal: controller.signal } : {}),
          ...(settings ? { body: JSON.stringify(settings) } : {}),
        });
        let payload;
        try { payload = await response.json(); } catch { throw Object.assign(new Error('Resposta inválida do serviço de configurações.'), { code: 'INVALID_RESPONSE' }); }
        if (!response.ok) throw Object.assign(new Error(messageFor(payload?.error, response.status)), { code: payload?.error || 'HTTP_ERROR', status: response.status });
        if (!payload || payload.ok !== true || !payload.settings || typeof payload.settings !== 'object') throw Object.assign(new Error('Resposta incompleta do serviço de configurações.'), { code: 'INVALID_RESPONSE' });
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') throw Object.assign(new Error('O serviço de configurações excedeu o tempo limite.'), { code: 'TIMEOUT' });
        throw error;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return Object.freeze({ get: () => request('GET'), put: settings => request('PUT', settings), reset: () => request('DELETE') });
  }
  function messageFor(code, status) {
    if (status === 401) return 'Sessão expirada ou não autenticada. Entre novamente.';
    if (status === 429) return 'Muitas solicitações. Aguarde antes de tentar novamente.';
    if (status === 413) return 'A solicitação excedeu o tamanho permitido.';
    if (status >= 500) return 'O serviço de configurações está indisponível.';
    return ({ invalid_json_body: 'Formato de solicitação inválido.', request_body_too_large: 'A solicitação excedeu o tamanho permitido.', not_found: 'Endpoint de configurações indisponível.', content_type_must_be_application_json: 'Formato de dados não aceito.' })[code] || 'Não foi possível concluir a operação de configurações.';
  }
  root.ZionInactivitySettingsApiClient = Object.freeze({ create, route: ROUTE });
})(typeof window !== 'undefined' ? window : globalThis);
