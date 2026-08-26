import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionMessages, buildCompanionSystemPrompt } from './model-message-builder.js';

test('model message builder preserves real multi-turn roles and compiles response policy', () => {
  const messages = buildCompanionMessages({
    message: '那你觉得我现在最需要什么？',
    runtimeContext: {
      turn: { messageId: 'u-2', intent: 'advice', emotion: { label: '焦虑与压力', valence: -0.2, arousal: 0.3 }, topics: ['创业项目'] },
      responsePlan: { mode: 'clarify_then_advise', goals: ['先回应处境'], askQuestion: true, maxQuestions: 1, mentionMemory: false, avoid: ['不要复述'] },
      messages: [
        { id: 'u-1', role: 'user', content: '我最近有点累。' },
        { id: 'a-1', role: 'assistant', content: '听起来你最近消耗很大。' },
        { id: 'u-2', role: 'user', content: '那你觉得我现在最需要什么？' }
      ]
    }
  });
  assert.deepEqual(messages.map(item => item.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(messages.at(-1).content, '那你觉得我现在最需要什么？');
  assert.match(messages[0].content, /clarify_then_advise/);
  assert.equal(messages[0].content.includes('user: 我最近有点累'), false);
});

test('system prompt can be compiled without a current user message', () => {
  const system = buildCompanionSystemPrompt({ runtimeContext: { responsePlan: { mode: 'reflect_and_continue' } } });
  assert.match(system, /reflect_and_continue/);
  assert.match(system, /当前时间/);
});
