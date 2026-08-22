import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryModuleClient } from '../server/memory-module-sdk.js';

const baseUrl = String(process.env.MEMORY_MODULE_URL || '').trim();
const tenantId = String(process.env.MEMORY_MODULE_SDK_TENANT_ID || '').trim();
const userId = String(process.env.MEMORY_MODULE_SDK_USER_ID || '').trim();
const agentId = String(process.env.MEMORY_MODULE_SDK_AGENT_ID || 'cochpia-sdk-smoke').trim();

if (!baseUrl || !tenantId || !userId) {
  console.log(JSON.stringify({ event: 'memory_module_sdk_smoke_skipped', reason: 'MEMORY_MODULE_URL_MEMORY_MODULE_SDK_TENANT_ID_MEMORY_MODULE_SDK_USER_ID_required' }));
  process.exit(0);
}

const marker = `sdk-smoke-${randomUUID()}`;
const idempotencyPrefix = `sdk-smoke-${randomUUID()}`;
const client = createMemoryModuleClient({
  baseUrl,
  getHeaders: () => ({
    ...(process.env.MEMORY_MODULE_SERVICE_TOKEN ? { Authorization: `Bearer ${process.env.MEMORY_MODULE_SERVICE_TOKEN}` } : {}),
    'x-memory-tenant-id': tenantId,
    'x-memory-user-id': userId,
    'x-memory-agent-id': agentId,
    'x-memory-actor-type': 'user'
  })
});

let createdMemory = null;
try {
  const created = await client.createMemory({ content: marker, sensitivity: 'S0', memoryType: 'sdk_smoke' }, { idempotencyKey: `${idempotencyPrefix}-create` });
  const memory = created.memory;
  createdMemory = memory;
  assert.ok(memory?.memoryId);
  const retrieved = await client.retrieve({ query: marker, purpose: 'profile_view', consistency_token: created.consistencyToken });
  assert.equal(retrieved.items.some(item => item.memoryId === memory.memoryId), true);
  const bundle = await client.buildContextBundle({ query: marker, purpose: 'profile_view', tokenBudget: 600, consistency_token: created.consistencyToken });
  assert.equal(Array.isArray(bundle.evidence), true);
  const forgotten = await client.forgetMemory(memory.memoryId, { resource_revision: memory.resourceRevision }, { idempotencyKey: `${idempotencyPrefix}-forget` });
  const afterForget = await client.retrieve({ query: marker, purpose: 'profile_view', consistency_token: forgotten.consistencyToken });
  assert.equal(afterForget.items.some(item => item.memoryId === memory.memoryId), false);
  console.log(JSON.stringify({ event: 'memory_module_sdk_smoke_passed', baseUrl, readYourWrite: true, contextBundle: true, forgetNegativeRead: true }));
} catch (error) {
  if (createdMemory?.memoryId) {
    try {
      await client.forgetMemory(createdMemory.memoryId, { resource_revision: createdMemory.resourceRevision }, { idempotencyKey: `${idempotencyPrefix}-cleanup` });
    } catch {
      // Preserve the original smoke failure; cleanup status must not expose memory content.
    }
  }
  console.error(JSON.stringify({ event: 'memory_module_sdk_smoke_failed', code: error.code || 'MEMORY_MODULE_SDK_SMOKE_FAILED', status: error.status || 0, message: error.message }));
  process.exitCode = 1;
}
