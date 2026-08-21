import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryService } from './memory-service.js';
import { createMemoryGateway } from './memory-gateway.js';

test('memory gateway falls back locally when MCP is unavailable', async () => {
  const state = { memories: [{ id: 'local-1', type: 'event', summary: 'local fallback', confidence: 1, source: 'test', visibility: 'shared', strength: 1 }], evidence: [] };
  const local = createMemoryService(state, async () => {});
  const gateway = createMemoryGateway(local, { mode: 'mcp', url: 'http://127.0.0.1:9/mcp', timeoutMs: 20, retryAttempts: 0, userId: () => 'user-a' });
  const result = await gateway.list({ limit: 5 });
  assert.equal(result[0].id, 'local-1');
});

test('memory gateway falls back locally on an invalid MCP tool response', async () => {
  const state = { memories: [{ id: 'local-2', type: 'event', summary: 'invalid response fallback', confidence: 1, source: 'test', visibility: 'shared', strength: 1 }], evidence: [] };
  const local = createMemoryService(state, async () => {});
  const gateway = createMemoryGateway(local, { mode: 'mcp', url: 'http://127.0.0.1:9/mcp', timeoutMs: 20, retryAttempts: 0, userId: () => 'user-a' });
  const result = await gateway.breath('fallback', 5);
  assert.equal(result[0].id, 'local-2');
});
