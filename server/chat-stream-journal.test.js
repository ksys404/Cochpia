import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStreamJournal, sanitizeChatStreamEvent } from './chat-stream-journal.js';

test('chat stream journal persists only bounded replay-safe SSE data', async () => {
  const calls = [];
  const journal = createChatStreamJournal({
    retentionMs: 60_000,
    storage: {
      create: async record => calls.push({ type: 'create', record }),
      append: async input => calls.push({ type: 'append', input }),
      finish: async input => calls.push({ type: 'finish', input })
    },
    now: () => new Date('2026-08-24T00:00:00.000Z')
  });
  await journal.create({ userId: 'user-a', runId: 'run-a', sessionId: 'session-a', attempt: 1 });
  await journal.append({ userId: 'user-a', runId: 'run-a', entry: { id: 'run-a:1', event: 'text', data: { delta: 'hello' } } });
  await journal.append({ userId: 'user-a', runId: 'run-a', entry: { id: 'run-a:2', event: 'tool', data: { runId: 'run-a', name: 'read', args: { path: '.env' } } } });
  await journal.finish({ userId: 'user-a', runId: 'run-a', state: 'completed' });
  const record = await journal.load({ userId: 'user-a', runId: 'run-a' });
  assert.deepEqual(record.events, [
    { id: 'run-a:1', event: 'text', data: { delta: 'hello' } },
    { id: 'run-a:2', event: 'tool', data: { runId: 'run-a', name: 'read' } }
  ]);
  assert.deepEqual(calls.map(call => call.type), ['create', 'append', 'append', 'finish']);
});

test('chat stream journal rejects unsupported events and expires records', async () => {
  const journal = createChatStreamJournal({ retentionMs: 30_000, now: () => new Date('2026-08-24T00:00:00.000Z') });
  await journal.create({ userId: 'user-a', runId: 'run-a', sessionId: 'session-a' });
  assert.equal(await journal.append({ userId: 'user-a', runId: 'run-a', entry: { id: 'run-a:1', event: 'heartbeat', data: {} } }), null);
  assert.equal(sanitizeChatStreamEvent({ id: 'run-a:1', event: 'text', data: { delta: 'x'.repeat(5_000) } }).data.delta.length, 4_000);
  const record = await journal.load({ userId: 'user-a', runId: 'run-a' });
  assert.equal(record.runId, 'run-a');
});
