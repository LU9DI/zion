/* Optional authenticated client for the Cloud preview; never stores credentials. */
(function (root) {
  'use strict';
  const ROUTE = '/api/v1/notifications/inactivity';
  const MAX_TIMEOUT_MS = 10000;
  function create({ getAccessToken, fetchImpl, baseUrl = '', timeoutMs = 5000 } = {}) {
    if (typeof getAccessToken !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('getAccessToken and fetchImpl are required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) throw new RangeError('timeoutMs must be between 100 and 10000');
    const base = String(baseUrl).replace(/\/$/u, '');
    async function request(path, method = 'GET') {
      const token = await getAccessToken();
      if (typeof token !== 'string' || !token.trim()) throw Object.assign(new Error('Sessão autenticada indisponível.'), { code: 'AUTH_REQUIRED' });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer;
      try {
        if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetchImpl(base + path, {
          method,
          headers: { authorization: `Bearer ${token.trim()}`, accept: 'application/json' },
          cache: 'no-store', credentials: 'omit', redirect: 'error',
          ...(controller ? { signal: controller.signal } : {}),
        });
        let payload;
        try { payload = await response.json(); } catch { throw Object.assign(new Error('Resposta inválida do serviço de notificações.'), { code: 'INVALID_RESPONSE' }); }
        if (!response.ok) throw Object.assign(new Error(messageFor(payload?.error, response.status)), { code: payload?.error || 'HTTP_ERROR', status: response.status });
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') throw Object.assign(new Error('O serviço de notificações excedeu o tempo limite.'), { code: 'TIMEOUT' });
        throw error;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    }
    return Object.freeze({
      list: ({ status = 'all', limit = 100 } = {}) => {
        if (!['all', 'pending', 'delivered'].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Parâmetros de listagem inválidos.');
        return request(`${ROUTE}?status=${encodeURIComponent(status)}&limit=${limit}`);
      },
      markViewed: id => {
        if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) throw new TypeError('ID de notificação inválido.');
        return request(`${ROUTE}/${encodeURIComponent(id)}/viewed`, 'POST');
      },
    });
  }
  function messageFor(code, status) {
    if (status === 401) return 'Sessão expirada ou não autenticada. Entre novamente.';
    if (status === 404) return 'Notificação não encontrada para esta conta.';
    if (status === 429) return 'Muitas solicitações. Aguarde antes de tentar novamente.';
    if (status >= 500) return 'O serviço de notificações está indisponível.';
    return 'Não foi possível concluir a operação de notificações.';
  }
  root.ZionInactivityNotificationsApiClient = Object.freeze({ create, route: ROUTE });
})(typeof window !== 'undefined' ? window : globalThis);
