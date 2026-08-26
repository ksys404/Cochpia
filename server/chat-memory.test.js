import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createChatMemoryAdapter } from './chat-memory.js';

function context() {
  return {
    tenantId: 'tenant-chat',
    subjectUserId: 'user-chat',
    actorType: 'user',
    actorId: 'user-chat',
    callerAgentId: 'cochpia',
    sessionId: null
  };
}

test('chat adapter uses Memory Module for legacy import, retrieval, and explicit remember', async () => {
  const memoryState = createMemoryModuleState();
  const state = { memoryModule: memoryState, memories: [{ id: 'legacy-1', type: 'preference', summary: '用户喜欢桂花乌龙', confidence: 0.91, importance: 0.8, source: 'legacy' }] };
  let persists = 0;
  const memory = createMemoryModule(memoryState, async () => { persists += 1; });
  const adapter = createChatMemoryAdapter({ memoryModule: memory, state, context: context(), persistState: async () => { persists += 1; } });

  const legacyResult = await adapter.retrieve('桂花乌龙');
  assert.equal(legacyResult.recalled.some(item => item.summary.includes('桂花乌龙')), true);
  assert.equal(memoryState.legacyImportVersion, 1);

  const event = await adapter.recordTurn({ eventId: 'chat-event-1', content: '记住：我周末喜欢散步', eventRole: 'user' });
  const remembered = await adapter.remember({ messageId: 'chat-message-1', content: '记住：我周末喜欢散步', sourceEventId: event.rawEventId });
  assert.equal(remembered.status, 'active');

  const next = await adapter.retrieve('周末散步');
  assert.equal(next.recalled.some(item => item.summary.includes('周末喜欢散步')), true);
  assert.equal(state.memories, undefined);
  assert.ok(persists > 0);
});

test('chat adapter remember is idempotent for regeneration and retry', async () => {
  const memoryState = createMemoryModuleState();
  const state = { memoryModule: memoryState, memories: [] };
  const memory = createMemoryModule(memoryState, async () => {});
  const adapter = createChatMemoryAdapter({ memoryModule: memory, state, context: context() });
  const first = await adapter.remember({ messageId: 'same-user-message', content: '我喜欢茉莉花茶' });
  const second = await adapter.remember({ messageId: 'same-user-message', content: '我喜欢茉莉花茶' });
  assert.equal(first.memory.memoryId, second.memory.memoryId);
  assert.equal(memoryState.assertions.length, 1);
});

test('chat adapter recalls a memory written after the current session snapshot', async () => {
  const memoryState = createMemoryModuleState();
  const state = { memoryModule: memoryState, memories: [] };
  const memory = createMemoryModule(memoryState, async () => {});
  const session = await memory.createSession(context(), { callerAgentId: 'cochpia', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const adapter = createChatMemoryAdapter({
    memoryModule: memory,
    state,
    context: { ...context(), sessionId: session.id }
  });

  const remembered = await adapter.remember({
    messageId: 'same-session-memory',
    content: '请记住：会话开始后我正在准备一个新项目',
  });
  const retrieved = await adapter.retrieve('会话开始后 新项目');

  assert.equal(remembered.status, 'active');
  assert.equal(retrieved.recalled.some(item => item.summary.includes('正在准备一个新项目')), true);
  assert.equal(retrieved.recalled.some(item => item.type === 'relevant'), true);
});
