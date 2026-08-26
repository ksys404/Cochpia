import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileChat, repairChat } from './companion-reconciliation.js';

const messages = [
  { id: 'user-1', role: 'user', content: 'hello', channel: '默认' },
  { id: 'assistant-1', role: 'assistant', content: 'reply', channel: '默认' }
];

test('reconciliation detects missing and conflicting chat events without returning content', () => {
  const report = reconcileChat({ sessionId: 'session-1', messages, rawEvents: [{ eventId: 'chat:session-1:user-1', sourceRevision: '1', eventRole: 'user', content: 'hello', isStreamFinal: true, metadata: { source_type: 'chat', source_id: 'session-1' } }] });
  assert.equal(report.matched, 1);
  assert.deepEqual(report.missing, [{ eventId: 'chat:session-1:assistant-1', eventType: 'conversation.assistant_message.completed', role: 'assistant' }]);
  assert.equal(Object.hasOwn(report, 'content'), false);

  const conflict = reconcileChat({ sessionId: 'session-1', messages, rawEvents: [{ eventId: 'chat:session-1:user-1', sourceRevision: '1', eventRole: 'user', content: 'changed', isStreamFinal: true, metadata: { source_type: 'chat', source_id: 'session-1' } }] });
  assert.equal(conflict.conflicts[0].expectedContentLength, 5);
  assert.equal(conflict.conflicts[0].storedContentLength, 7);
  assert.equal(conflict.repairable, false);
});

test('repair replays missing events through the injected collector', async () => {
  const collected = [];
  const result = await repairChat({
    sessionId: 'session-1',
    messages,
    rawEvents: [],
    collectEvent: async event => { collected.push(event); return { result: 'accepted_stored' }; }
  });
  assert.equal(collected.length, 2);
  assert.equal(collected[0].eventType, 'conversation.user_message.created');
  assert.equal(collected[1].allowInternal, true);
  assert.equal(result.repaired.length, 2);
  assert.equal(result.report.missing.length, 0);
});

test('reconciliation treats a newer source revision as the canonical edited message', () => {
  const editedMessages = [{ id: 'user-1', role: 'user', content: 'edited hello', sourceRevision: '2', channel: '默认' }];
  const report = reconcileChat({
    sessionId: 'session-1',
    messages: editedMessages,
    rawEvents: [
      { eventId: 'chat:session-1:user-1', sourceRevision: '1', eventRole: 'user', content: 'hello', isStreamFinal: true, createdAt: '2026-08-25T00:00:00.000Z', metadata: { source_type: 'chat', source_id: 'session-1' } },
      { eventId: 'chat:session-1:user-1', sourceRevision: '2', eventRole: 'user', content: 'edited hello', isStreamFinal: true, createdAt: '2026-08-25T00:01:00.000Z', metadata: { source_type: 'chat', source_id: 'session-1' } }
    ]
  });
  assert.equal(report.actualCount, 1);
  assert.equal(report.matched, 1);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.extra, []);
});
