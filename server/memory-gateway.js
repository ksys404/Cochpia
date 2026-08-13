import { createMcpClient } from './mcp-client.js';

export function createMemoryGateway(localMemory, options = {}) {
  const remote = options.mode === 'mcp'
    ? createMcpClient({ url: options.url, token: options.token, timeoutMs: options.timeoutMs, retryAttempts: options.retryAttempts })
    : null;
  const callRemote = async (name, args, fallback) => {
    if (!remote) return fallback();
    try {
      const result = await remote.call(name, { ...args, userId: args.userId || options.userId?.() });
      if (!result || result.isError) throw Object.assign(new Error('MCP tool returned an error'), { code: 'MCP_TOOL_ERROR' });
      const text = result?.content?.find(item => item.type === 'text')?.text;
      if (!text) throw Object.assign(new Error('MCP tool returned an invalid response'), { code: 'MCP_INVALID_RESPONSE' });
      try { return JSON.parse(text); } catch (error) { throw Object.assign(new Error('MCP tool returned invalid JSON'), { code: 'MCP_INVALID_RESPONSE', cause: error }); }
    } catch (error) {
      console.error(JSON.stringify({ event: 'memory_mcp_degraded', code: error.code || 'MCP_REQUEST_FAILED', tool: name }));
      return fallback();
    }
  };
  return {
    mode: options.mode || 'local',
    listTools: () => localMemory.listTools(),
    breath: (query, limit, userId) => callRemote('breath', { query, limit, userId }, () => localMemory.breath(query, limit)),
    hold: (input, userId) => callRemote('hold', { ...input, userId }, () => localMemory.hold(input)),
    list: (options, userId) => callRemote('list', { ...options, userId }, () => localMemory.list(options)),
    get: (id, userId) => callRemote('get', { id, userId }, () => localMemory.get(id)),
    update: (id, input, userId) => callRemote('update', { id, ...input, userId }, () => localMemory.update(id, input)),
    remove: (id, userId) => callRemote('remove', { id, userId }, () => localMemory.remove(id)),
    revoke: (id, userId) => callRemote('revoke', { id, userId }, () => localMemory.revoke(id)),
    exportMemories: userId => callRemote('export', { userId }, () => localMemory.exportMemories()),
    dream: (limit, userId) => callRemote('dream', { limit, userId }, () => localMemory.dream(limit)),
    grow: (input, userId) => callRemote('grow', { ...input, userId }, () => localMemory.grow(input)),
    trace: (id, userId) => callRemote('trace', { id, userId }, () => localMemory.trace(id)),
    updateEvidence: (id, status, userId) => callRemote('updateEvidence', { id, status, userId }, () => localMemory.updateEvidence(id, status))
  };
}
