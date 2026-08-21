import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeContext, findRegenerationTarget } from './runtime-context.js';

test('runtime context keeps bounded history, personality, and recalled memory', () => {
  const context = buildRuntimeContext({
    messages: Array.from({ length: 25 }, (_, index) => ({ id: String(index), role: 'user', content: `message-${index}` })),
    personality: { version: 4, summary: 'warm', traits: [{ key: 'warmth', label: 'Warmth', value: 0.8 }] },
    recalled: [{ id: 'memory-1', type: 'event', summary: 'A shared event', confidence: 0.9, source: 'chat' }]
  });
  assert.equal(context.messages.length, 20);
  assert.equal(context.messages[0].id, '5');
  assert.deepEqual(context.personality.traits[0], { key: 'warmth', label: 'Warmth', value: 0.8 });
  assert.equal(context.recalled[0].summary, 'A shared event');
});

test('runtime context includes a conversation summary when provided', () => {
  const context = buildRuntimeContext({ summary: 'earlier conversation', messages: [] });
  assert.equal(context.summary, 'earlier conversation');
  assert.equal(buildRuntimeContext({ messages: [] }).summary, '');
});

test('runtime context includes persona and upcoming events when provided', () => {
  const context = buildRuntimeContext({
    messages: [],
    persona: '你是一个温柔的陪伴者',
    upcomingEvents: [{ type: 'anniversary', title: '纪念日', date: '2026-08-15', note: '很重要' }]
  });
  assert.equal(context.persona, '你是一个温柔的陪伴者');
  assert.equal(context.upcomingEvents[0].title, '纪念日');
  assert.equal(buildRuntimeContext({ messages: [] }).persona, '');
  assert.deepEqual(buildRuntimeContext({ messages: [] }).upcomingEvents, []);
});

test('regeneration target requires an assistant message with a preceding user message', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: 'hi' }
  ];
  assert.equal(findRegenerationTarget(messages, 'a1').user.id, 'u1');
  assert.equal(findRegenerationTarget(messages, 'u1'), null);
  assert.equal(findRegenerationTarget(messages, 'missing'), null);
});
