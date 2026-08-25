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

test('Memory Module compatibility adapter exposes candidate, confirmation, pin, correction, forget, and lifecycle replay', async () => {
  const state = { memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({ getState: () => state });
  const compatibility = runtime.compatibilityForRequest(request);
  const module = runtime.moduleForRequest(request);
  const context = runtime.contextFromRequest(request);

  const created = await compatibility.hold({ type: 'preference', summary: '喜欢红茶' });
  const pinned = await compatibility.pin(created.id, { resource_revision: created.resourceRevision, idempotency_key: 'compat-pin-1' });
  const pinReplay = await compatibility.pin(created.id, { resource_revision: created.resourceRevision, idempotency_key: 'compat-pin-1' });
  assert.equal(pinned.metadata.versionId, created.metadata.versionId);
  assert.equal(pinned.resourceRevision, pinReplay.resourceRevision);

  const corrected = await compatibility.update(created.id, {
    summary: '现在更喜欢乌龙茶',
    resource_revision: pinned.resourceRevision,
    idempotency_key: 'compat-correct-1'
  });
  assert.equal(corrected.summary, '现在更喜欢乌龙茶');
  const unpinned = await compatibility.unpin(corrected.id, { resource_revision: corrected.resourceRevision, idempotency_key: 'compat-unpin-1' });
  assert.equal(unpinned.status, 'active');

  const forgotten = await compatibility.forget(unpinned.id, { resource_revision: unpinned.resourceRevision, idempotency_key: 'compat-forget-1' });
  assert.equal(forgotten.status, 'forgotten');
  assert.equal(forgotten.summary, '');
  assert.equal((await compatibility.list({ includeRevoked: true })).some(item => item.id === created.id && item.status === 'forgotten'), true);

  const sensitive = await compatibility.hold({ type: 'fact', summary: '家庭冲突记录', sensitivity: 'S2', idempotency_key: 'compat-s2-1' });
  assert.equal(sensitive.status, 'pending_confirmation');
  assert.equal(sensitive.summary, '家庭冲突记录');
  assert.equal(typeof sensitive.confirmation.id, 'string');
  const confirmations = await compatibility.listConfirmations();
  assert.equal(confirmations.items.some(item => item.id === sensitive.confirmation.id), true);
  const confirmed = await compatibility.confirm(sensitive.confirmation.id, {
    resource_revision: sensitive.confirmation.resourceRevision,
    idempotency_key: 'compat-confirm-1'
  });
  assert.equal(confirmed.status, 'active');
  assert.equal(confirmed.summary, '家庭冲突记录');

  const event = await module.recordEvent(context, { eventId: 'compat-candidate-event', content: '请记住我喜欢桂花茶' });
  const candidate = await module.createCandidate(context, { sourceEventId: event.rawEventId, content: '喜欢桂花茶', memoryType: 'preference', sensitivity: 'S0' });
  const listedCandidates = await compatibility.list({ status: 'candidate' });
  assert.equal(listedCandidates.some(item => item.id === candidate.memory.memoryId && item.summary === '喜欢桂花茶'), true);
  const promoted = await compatibility.promote(candidate.memory.memoryId, {
    resource_revision: candidate.memory.resourceRevision,
    idempotency_key: 'compat-promote-1'
  });
  assert.equal(promoted.status, 'active');
  assert.equal(promoted.summary, '喜欢桂花茶');
});

test('Memory Module runtime rebinds when account cleanup replaces the canonical memory state object', async () => {
  const state = { memoryModule: createMemoryModuleState() };
  const runtime = createMemoryModuleRuntime({ getState: () => state });
  const first = runtime.moduleForRequest(request);
  state.memoryModule = createMemoryModuleState();
  const second = runtime.moduleForRequest(request);

  assert.notEqual(second, first);
  const context = runtime.contextFromRequest(request);
  await second.createSession(context, { id: 'rebound-session', callerAgentId: 'cochpia' });
  assert.equal(state.memoryModule.sessions.some(item => item.id === 'rebound-session'), true);
  assert.equal(first.state.sessions.some(item => item.id === 'rebound-session'), false);
});
