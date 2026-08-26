import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryWriteIngress, createMcpWriteIngress } from './mcp-write.js';

test('MCP write ingress emits a bounded canonical command without copying arguments', async () => {
  let captured;
  const ingress = createMcpWriteIngress({
    collector: { collect: async (...args) => { captured = args; return { rawEventId: 'raw-mcp-1' }; } }
  });
  const result = await ingress({
    request: { requestId: 'request-1', get: () => '' },
    id: 'rpc-1',
    name: 'hold',
    args: { content: 'private memory', sensitivity: 'S2', idempotencyKey: 'write-1' }
  });
  assert.equal(result.rawEventId, 'raw-mcp-1');
  assert.equal(captured[0].event_type, 'memory.write.requested');
  assert.equal(captured[0].producer, 'mcp-adapter');
  assert.deepEqual(captured[0].structured_data, { tool: 'hold', request_id: 'request-1', rpc_id: 'rpc-1' });
  assert.equal(Object.hasOwn(captured[0].structured_data, 'content'), false);
  assert.equal(captured[1].request.requestId, 'request-1');
});

test('MCP do-not-store directives propagate to the ingress event', async () => {
  let captured;
  const ingress = createMcpWriteIngress({ collector: { collect: async (...args) => { captured = args; return {}; } } });
  await ingress({ request: { headers: { 'idempotency-key': 'header-key' } }, name: 'grow', args: { storage_directive: 'do_not_store' } });
  assert.equal(captured[0].privacy_directive, 'do_not_store');
  assert.equal(captured[0].idempotency_key, 'mcp-memory-write:grow:header-key');
});

test('the compatibility API uses a separate trusted producer on the same event boundary', async () => {
  let captured;
  const ingress = createMemoryWriteIngress({
    producer: 'memory-api-adapter',
    sourcePrefix: 'api',
    collector: { collect: async (...args) => { captured = args; return { rawEventId: 'raw-api-1' }; } }
  });
  await ingress({ request: { requestId: 'request-api' }, name: 'hold', args: { idempotency_key: 'api-write-1' } });
  assert.equal(captured[0].producer, 'memory-api-adapter');
  assert.equal(captured[0].event_id, 'api:hold:api-write-1');
  assert.equal(captured[0].source_id, 'api:hold');
});
