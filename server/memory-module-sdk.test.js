import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleClient, MemoryModuleClientError } from './memory-module-sdk.js';

test('SDK exposes V1 resources without exposing tenant/user body fields', async () => {
  const calls = [];
  const client = createMemoryModuleClient({
    baseUrl: 'https://memory.example.test',
    getHeaders: () => ({ Authorization: 'Bearer fixture' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ status: 'active' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.createMemory({ content: '喜欢红茶', sensitivity: 'S0' });
  assert.equal(calls[0].url, 'https://memory.example.test/v1/memories');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture');
  assert.equal(JSON.parse(calls[0].options.body).tenant_id, undefined);
});

test('SDK sends mutation idempotency keys as headers without adding tenant or user fields', async () => {
  const calls = [];
  const client = createMemoryModuleClient({
    baseUrl: 'https://memory.example.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ status: 'active' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.createMemory({ content: '幂等', sensitivity: 'S0' }, { idempotencyKey: 'sdk-key-1' });
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'sdk-key-1');
  assert.equal(JSON.parse(calls[0].options.body).idempotency_key, undefined);
});

test('SDK turns the unified API error body into a typed client error', async () => {
  const client = createMemoryModuleClient({
    baseUrl: 'https://memory.example.test',
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'MEMORY_NOT_FOUND', message: 'Memory not found' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(() => client.getMemory('missing'), error => error instanceof MemoryModuleClientError && error.code === 'MEMORY_NOT_FOUND' && error.status === 404);
});

test('SDK exposes proactive mention recording without adding tenant or user fields', async () => {
  const calls = [];
  const client = createMemoryModuleClient({
    baseUrl: 'https://memory.example.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ status: 'recorded', recordedMemoryIds: ['memory-a'] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.recordMention({ memory_ids: ['memory-a'], topic_key: 'preference:tea' }, { idempotencyKey: 'mention-key' });
  assert.equal(calls[0].url, 'https://memory.example.test/v1/mentions');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'mention-key');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.tenant_id, undefined);
  assert.equal(payload.user_id, undefined);
});
