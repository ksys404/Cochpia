import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseEvent, formatSseEvent, replaySseEvents } from './sse.js';

test('SSE events have monotonic IDs and valid wire format', () => {
  const run = { id: 'run-1', sequence: 0, events: [] };
  const first = createSseEvent(run, 'meta', { runId: 'run-1' });
  const second = createSseEvent(run, 'text', { delta: 'hello' });
  assert.equal(first.id, 'run-1:1');
  assert.equal(second.id, 'run-1:2');
  assert.match(formatSseEvent(second), /^id: run-1:2\nevent: text\ndata: \{"delta":"hello"\}\n\n$/);
});

test('SSE replay only returns events after Last-Event-ID', () => {
  const events = [1, 2, 3].map(sequence => ({ id: `run-1:${sequence}`, event: 'text', data: { sequence } }));
  assert.deepEqual(replaySseEvents(events, 'run-1:1').map(event => event.data.sequence), [2, 3]);
  assert.deepEqual(replaySseEvents(events, '').map(event => event.data.sequence), [1, 2, 3]);
});
