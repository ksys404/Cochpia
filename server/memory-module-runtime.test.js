import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleRuntime } from './memory-module-runtime.js';

const request = { body: {}, query: {}, get: () => undefined };

test('Memory Module runtime migrates legacy memories once and removes the legacy field', async () => {
  const state = {
    memoryModule: createMemoryModuleState(),
    memories: [{ id: 'legacy-1', type: 'preference', summary: '用户喜欢桂花乌龙', confidence: 0.91, importance: 0.8, source: 'legacy' }]
  };
  let persists = 0;
  const runtime = createMemoryModuleRuntime({ getState: () => state, persistState: async () => { persists += 1; } });

  const compatibility = runtime.compatibilityForRequest(request);
  const memories = await compatibility.list({ limit: 10 });

  assert.equal(memories.length, 1);
  assert.equal(memories[0].summary, '用户喜欢桂花乌龙');
  assert.equal(state.memories, undefined);
  assert.equal(state.memoryModule.legacyImportVersion, 1);
  assert.ok(persists > 0);

  const created = await compatibility.hold({ type: 'goal', summary: '准备周末散步' });
  assert.equal(created.summary, '准备周末散步');
  assert.equal(state.memories, undefined);
  assert.equal((await compatibility.list({ limit: 10 })).length, 2);
});

test('Memory Module compatibility mutations operate on canonical assertions', async () => {
  const state = { memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({ getState: () => state });
  const compatibility = runtime.compatibilityForRequest(request);

  const created = await compatibility.hold({ type: 'preference', summary: '喜欢茉莉花茶' });
  const revoked = await compatibility.revoke(created.id);
  assert.equal(revoked.status, 'revoked');
  assert.equal((await compatibility.list({ limit: 10 })).length, 0);

  const canonical = runtime.moduleForRequest(request).list(runtime.contextFromRequest(request), { purpose: 'governance' });
  assert.equal(canonical.length, 1);
  assert.equal(canonical[0].status, 'revoked');
});

test('Memory Module compatibility retrieval and dream expose canonical content', async () => {
  const state = { memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({ getState: () => state });
  const compatibility = runtime.compatibilityForRequest(request);
  await compatibility.hold({ type: 'preference', summary: '喜欢安静的清晨散步' });

  const recalled = await compatibility.breath('清晨散步', 5);
  const dreamed = await compatibility.dream(5);
  assert.equal(recalled[0].summary, '喜欢安静的清晨散步');
  assert.equal(dreamed[0].summary, '喜欢安静的清晨散步');
});

test('Memory Module compatibility update creates a canonical version', async () => {
  const state = { memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({ getState: () => state });
  const compatibility = runtime.compatibilityForRequest(request);
  const created = await compatibility.hold({ type: 'fact', summary: '周末去公园' });
  const updated = await compatibility.update(created.id, { summary: '周末去海边' });

  assert.equal(updated.summary, '周末去海边');
  const canonical = runtime.moduleForRequest(request).get(runtime.contextFromRequest(request), created.id, { purpose: 'governance' });
  assert.equal(canonical.content, '周末去海边');
  assert.ok(canonical.versionId);
});

test('Memory Module compatibility remove is idempotent at the boundary', async () => {
  const state = { memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({ getState: () => state });
  const compatibility = runtime.compatibilityForRequest(request);
  const created = await compatibility.hold({ type: 'fact', summary: '一次性删除测试' });

  assert.equal(await compatibility.remove(created.id), true);
  assert.equal(await compatibility.remove(created.id), false);
});
