const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class McpClientError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'McpClientError';
    this.code = code;
  }
}

function classifyHttpError(status) {
  if (status === 401 || status === 403) return 'MCP_AUTH_FAILED';
  if (status === 429) return 'MCP_RATE_LIMIT';
  if (status >= 500) return 'MCP_UNAVAILABLE';
  return 'MCP_REQUEST_FAILED';
}

export function createMcpClient({ url, token, timeoutMs = 5000, retryAttempts = 1 } = {}) {
  let sessionId;
  let requestId = 0;
  let initialized = false;

  async function request(method, params = {}) {
    if (!url) throw new McpClientError('MCP_NOT_CONFIGURED', 'MEMORY_MCP_URL is required when MEMORY_MODE=mcp');
    let lastError;
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
          signal: controller.signal
        });
        const responseSessionId = response.headers.get('mcp-session-id');
        if (responseSessionId) sessionId = responseSessionId;
        const raw = await response.text();
        let payload;
        try { payload = raw ? JSON.parse(raw) : null; } catch (error) { throw new McpClientError('MCP_INVALID_RESPONSE', 'MCP returned invalid JSON', error); }
        if (!response.ok) throw new McpClientError(classifyHttpError(response.status), payload?.error?.message || `MCP request failed with status ${response.status}`);
        if (!payload || payload.jsonrpc !== '2.0' || payload.error) throw new McpClientError(payload?.error?.code || 'MCP_TOOL_ERROR', payload?.error?.message || 'MCP returned an invalid JSON-RPC response');
        if (method === 'initialize') initialized = true;
        return payload.result;
      } catch (error) {
        if (error instanceof McpClientError) lastError = error;
        else if (error.name === 'AbortError') lastError = new McpClientError('MCP_TIMEOUT', 'Memory MCP request timed out', error);
        else lastError = new McpClientError('MCP_NETWORK_FAILED', 'Memory MCP network request failed', error);
        if (attempt < retryAttempts) await sleep(100 * (attempt + 1));
      } finally { clearTimeout(timer); }
    }
    throw lastError;
  }

  return {
    async initialize() { return request('initialize', { protocolVersion: '2025-06-18', sessionId }); },
    async listTools() { if (!initialized) await request('initialize', { protocolVersion: '2025-06-18' }); return request('tools/list', { sessionId }); },
    async call(name, args = {}) { if (!initialized) await request('initialize', { protocolVersion: '2025-06-18' }); return request('tools/call', { name, arguments: args, sessionId }); }
  };
}
