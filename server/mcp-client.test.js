import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMcpClient } from './mcp-client.js';

function startFixture(handler) {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('MCP client initializes before a tool call and parses JSON-RPC responses', async () => {
  const methods = [];
  const { server, url } = await startFixture(async (request, response) => {
    const body = await new Promise(resolve => { let raw = ''; request.on('data', chunk => { raw += chunk; }); request.on('end', () => resolve(JSON.parse(raw))); });
    methods.push(body.method);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize' ? { ok: true } : { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }));
  });
  try {
    const client = createMcpClient({ url, timeoutMs: 500, retryAttempts: 0 });
    assert.deepEqual(await client.call('breath', { userId: 'user-a' }), { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
    assert.deepEqual(methods, ['initialize', 'tools/call']);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('MCP client classifies timeout, authentication, rate-limit, invalid response, and network failures', async () => {
  const cases = [
    { name: 'timeout', handler: async () => {}, expected: 'MCP_TIMEOUT', options: { timeoutMs: 20 } },
    { name: 'auth', handler: async (_, response) => { response.statusCode = 401; response.end(JSON.stringify({ error: { message: 'unauthorized' } })); }, expected: 'MCP_AUTH_FAILED' },
    { name: 'rate', handler: async (_, response) => { response.statusCode = 429; response.end(JSON.stringify({ error: { message: 'rate limited' } })); }, expected: 'MCP_RATE_LIMIT' },
    { name: 'invalid', handler: async (_, response) => { response.end('not-json'); }, expected: 'MCP_INVALID_RESPONSE' }
  ];
  for (const item of cases) {
    const { server, url } = await startFixture(item.handler);
    try { await assert.rejects(createMcpClient({ url, timeoutMs: item.options?.timeoutMs || 500, retryAttempts: 0 }).call('breath', { userId: 'user-a' }), error => error.code === item.expected); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
  const unused = await startFixture(() => {});
  await new Promise(resolve => unused.server.close(resolve));
  await assert.rejects(createMcpClient({ url: unused.url, timeoutMs: 50, retryAttempts: 0 }).call('breath', { userId: 'user-a' }), error => error.code === 'MCP_NETWORK_FAILED' || error.code === 'MCP_TIMEOUT');
});
