import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionCollector } from './interaction-collector.js';

const context = { tenantId: 'tenant-collector', subjectUserId: 'user-collector', actorType: 'user', actorId: 'user-collector', callerAgentId: 'cochpia' };

test('collector normalizes and appends an ingress event exactly once at the adapter boundary', async () => {
  const calls = [];
  const collector = createInteractionCollector({
    contextFromRequest: async () => context,
    appendEvent: async (resolved, input, meta) => { calls.push({ resolved, input, meta }); return { result: 'accepted_stored', rawEventId: 'raw-1', commitSeq: 4 }; },
    now: () => new Date('2026-08-24T00:00:00.000Z')
  });
  const result = await collector.collect({ event_type: 'conversation.user_message.created', source_type: 'chat', source_id: 'session-1', content: 'hello' }, { sourceId: 'session-1', sessionId: 'session-1', producer: 'chat-adapter' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.eventId, result.envelope.event_id);
  assert.equal(calls[0].input.metadata.event_type, 'conversation.user_message.created');
  assert.equal(result.rawEventId, 'raw-1');
});

test('collector uses the server-resolved source and rejects a conflicting client source', async () => {
  const collector = createInteractionCollector({ contextFromRequest: () => context, appendEvent: async () => ({}) });
  await assert.rejects(
    () => collector.collect({ event_type: 'conversation.user_message.created', source_type: 'chat', source_id: 'client-session', content: 'hello' }, { sourceId: 'server-session', producer: 'chat-adapter' }),
    error => error.code === 'SOURCE_CONTEXT_MISMATCH'
  );
});
