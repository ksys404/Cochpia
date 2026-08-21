import { spawn } from 'node:child_process';

export class StdioMcpError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'StdioMcpError'; this.code = code; }
}

export function createStdioMcpClient({ command, args = [], timeoutMs = 5000 } = {}) {
  if (!command) throw new StdioMcpError('MCP_NOT_CONFIGURED', 'MUSIC_MCP_COMMAND is required');
  let child = null;
  let buffer = '';
  let requestId = 0;
  let initialized = false;
  const pending = new Map();
  const rejectAll = error => { pending.forEach(item => { clearTimeout(item.timer); item.reject(error); }); pending.clear(); };
  const handleMessage = payload => {
    const item = pending.get(payload.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(payload.id);
    if (payload.error) item.reject(new StdioMcpError(payload.error.code || 'MCP_TOOL_ERROR', payload.error.message || 'Music MCP returned an error'));
    else item.resolve(payload.result);
  };
  const consume = chunk => {
    buffer += chunk.toString();
    while (buffer.length) {
      const separator = buffer.indexOf('\r\n\r\n');
      const alternateSeparator = buffer.indexOf('\n\n');
      const headerEnd = separator >= 0 && (alternateSeparator < 0 || separator < alternateSeparator) ? separator : alternateSeparator;
      if (headerEnd < 0) return;
      const headers = buffer.slice(0, headerEnd);
      const match = headers.match(/content-length\s*:\s*(\d+)/i);
      if (!match) { buffer = buffer.slice(headerEnd + (headerEnd === separator ? 4 : 2)); continue; }
      const bodyStart = headerEnd + (headerEnd === separator ? 4 : 2);
      const length = Number(match[1]);
      if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < length) return;
      const body = Buffer.from(buffer.slice(bodyStart), 'utf8').subarray(0, length).toString('utf8');
      buffer = Buffer.from(buffer.slice(bodyStart), 'utf8').subarray(length).toString('utf8');
      try { handleMessage(JSON.parse(body)); } catch { /* Ignore malformed frames; pending request will time out. */ }
    }
  };
  const ensureProcess = () => {
    if (child) return;
    child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', error => rejectAll(new StdioMcpError('MCP_PROCESS_FAILED', 'Music MCP process failed to start', error)));
    child.on('exit', code => { child = null; rejectAll(new StdioMcpError('MCP_PROCESS_EXITED', `Music MCP process exited with code ${code}`)); });
    child.stdout.on('data', consume);
    child.stderr.on('data', () => {});
  };
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    ensureProcess();
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new StdioMcpError('MCP_TIMEOUT', `Music MCP request timed out: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
  return {
    async initialize() { if (!initialized) { await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'cochpia', version: '0.1.0' } }); initialized = true; } },
    async call(name, args = {}) { await this.initialize(); return request('tools/call', { name, arguments: args }); },
    close() { rejectAll(new StdioMcpError('MCP_CLOSED', 'Music MCP client closed')); child?.kill(); child = null; }
  };
}
