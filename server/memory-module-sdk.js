export class MemoryModuleClientError extends Error {
  constructor(message, { code = 'MEMORY_MODULE_REQUEST_FAILED', status = 0, body = null } = {}) {
    super(message);
    this.name = 'MemoryModuleClientError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export function createMemoryModuleClient({ baseUrl = '', fetchImpl = globalThis.fetch, headers = {}, getHeaders = () => ({}) } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  const request = async (path, { method = 'GET', body, query, idempotencyKey } = {}) => {
    const url = new URL(path, baseUrl || 'http://memory-module.invalid');
    if (query) for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url.toString(), {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}), ...headers, ...getHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = payload?.error || {};
      throw new MemoryModuleClientError(error.message || 'Memory Module request failed', { code: error.code, status: response.status, body: payload });
    }
    return payload;
  };
  return {
    request,
    createSession: (body, options = {}) => request('/v1/sessions', { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    recordEvent: body => request('/v1/events', { method: 'POST', body }),
    grantAccess: (body, options = {}) => request('/v1/access-grants', { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    createMemory: (body, options = {}) => request('/v1/memories', { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    listMemories: query => request('/v1/memories', { query }),
    getMemory: (id, query) => request(`/v1/memories/${encodeURIComponent(id)}`, { query }),
    retrieve: body => request('/v1/retrieve', { method: 'POST', body }),
    buildContextBundle: body => request('/v1/context-bundles', { method: 'POST', body }),
    correctMemory: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}/correct`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    promoteCandidate: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}/promote`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    pinMemory: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}/pin`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    unpinMemory: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}/unpin`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    revokeMemory: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}/revoke`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    forgetMemory: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}/forget`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    forgetTarget: (body, options = {}) => request('/v1/governance/forget', { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    deleteMemory: (id, body, options = {}) => request(`/v1/memories/${encodeURIComponent(id)}`, { method: 'DELETE', body, idempotencyKey: options.idempotencyKey }),
    listConfirmations: query => request('/v1/confirmations', { query }),
    confirmMemory: (id, body, options = {}) => request(`/v1/confirmations/${encodeURIComponent(id)}/confirm`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    rejectMemory: (id, body, options = {}) => request(`/v1/confirmations/${encodeURIComponent(id)}/reject`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    confirmAccess: (id, options = {}) => request(`/v1/access-confirmations/${encodeURIComponent(id)}/confirm`, { method: 'POST', idempotencyKey: options.idempotencyKey }),
    recordMention: (body, options = {}) => request('/v1/mentions', { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    writeCurrentState: (sessionId, body, options = {}) => request(`/v1/sessions/${encodeURIComponent(sessionId)}/current-state`, { method: 'POST', body, idempotencyKey: options.idempotencyKey }),
    getDeletionOperation: id => request(`/v1/deletion-operations/${encodeURIComponent(id)}`)
  };
}
