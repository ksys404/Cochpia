import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionOutboxDispatcher, enqueueInteractionEvent, reconcileInteractionOutbox } from './interaction-outbox.js';

const taskInput = {
  event_id: 'task:task-1:created:1',
  event_type: 'task.created',
  source_type: 'task',
  source_id: 'task-1',
  content_type: 'structured',
  content: 'Task created',
  structured_data: { task_id: 'task-1', status: 'open' },
  producer: 'task-adapter'
};

test('interaction outbox canonicalizes ingress payloads and deduplicates idempotency keys', () => {
  const state = { companion: {} };
  const first = enqueueInteractionEvent(state, taskInput, { now: '2026-08-24T00:00:00.000Z' });
  const duplicate = enqueueInteractionEvent(state, taskInput, { now: '2026-08-24T00:00:01.000Z' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(state.companion.interactionOutbox.length, 1);
  assert.equal(first.entry.eventInput.event_type, 'task.created');
  assert.equal(first.entry.eventInput.event_class, undefined);
});

test('interaction outbox dispatch is at-least-once and records the raw event result', async () => {
  const state = { companion: {} };
  enqueueInteractionEvent(state, taskInput, { now: '2026-08-24T00:00:00.000Z' });
  const calls = [];
  let persists = 0;
  const dispatcher = createInteractionOutboxDispatcher({
    state,
    persist: async () => { persists += 1; },
    dispatch: async ({ entry }) => { calls.push(entry.eventInput.event_id); return { rawEventId: 'raw-task-1', commitSeq: 7 }; },
    now: () => new Date('2026-08-24T00:00:00.000Z')
  });
  const stats = await dispatcher.flush({ request: {} });
  const entry = state.companion.interactionOutbox[0];
  assert.deepEqual(stats, { skipped: false, processed: 1, completed: 1, failed: 0, pending: 0 });
  assert.deepEqual(calls, ['task:task-1:created:1']);
  assert.equal(entry.status, 'completed');
  assert.equal(entry.rawEventId, 'raw-task-1');
  assert.equal(entry.commitSeq, 7);
  assert.equal(persists, 2);
});

test('interaction outbox dead-letters a non-retryable exhausted entry without dropping it', async () => {
  const state = { companion: {} };
  enqueueInteractionEvent(state, taskInput, { now: '2026-08-24T00:00:00.000Z' });
  const dispatcher = createInteractionOutboxDispatcher({
    state,
    maxAttempts: 1,
    persist: async () => {},
    dispatch: async () => { throw Object.assign(new Error('collector unavailable'), { code: 'COLLECTOR_UNAVAILABLE' }); },
    now: () => new Date('2026-08-24T00:00:00.000Z')
  });
  const stats = await dispatcher.flush({ request: {} });
  const entry = state.companion.interactionOutbox[0];
  assert.equal(stats.failed, 1);
  assert.equal(stats.pending, 0);
  assert.equal(entry.status, 'dead_letter');
  assert.equal(entry.lastErrorCode, 'COLLECTOR_UNAVAILABLE');
  assert.equal(entry.attempts, 1);
});

test('interaction outbox reconciliation restores missing pending ingress and remains idempotent', () => {
  const state = { companion: {} };
  const input = {
    event_id: 'life:life-command-repair',
    event_type: 'life.action.completed',
    source_type: 'game',
    source_id: 'session-repair',
    session_id: 'session-repair',
    content_type: 'structured',
    content: 'Replayed life event',
    structured_data: { actionId: 'walk' },
    producer: 'life-adapter',
    idempotency_key: 'life-command-repair'
  };
  const first = reconcileInteractionOutbox(state, [input], { now: '2026-08-24T00:00:00.000Z' });
  const replay = reconcileInteractionOutbox(state, [input], { now: '2026-08-24T00:00:01.000Z' });
  assert.deepEqual(first.repaired.map(item => item.idempotencyKey), ['life-command-repair']);
  assert.deepEqual(replay.existing.map(item => item.idempotencyKey), ['life-command-repair']);
  assert.equal(state.companion.interactionOutbox.length, 1);
  assert.equal(state.companion.interactionOutbox[0].eventInput.session_id, 'session-repair');
});
