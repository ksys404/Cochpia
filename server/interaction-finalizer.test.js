import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionFinalizer } from './interaction-finalizer.js';

test('Finalizer commits the assistant event before projection and isolates projection failure', async () => {
  const order = [];
  const collector = { collect: async input => { order.push('event'); return { envelope: input, storage: { result: 'accepted_stored' }, rawEventId: 'raw-a' }; } };
  const finalizer = createInteractionFinalizer({ collector });
  const result = await finalizer.finalize({
    context: { tenantId: 'tenant-finalizer', subjectUserId: 'user-finalizer', actorType: 'user', actorId: 'user-finalizer' },
    sessionId: 'session-1',
    assistantMessage: { id: 'assistant-1', content: 'reply' },
    runId: 'run-1',
    parentEventId: 'user-event-1',
    chunkSeq: 4,
    resumeCursor: 'run-1:4',
    completionReason: 'stop',
    commit: async () => { order.push('commit'); return { messageId: 'assistant-1' }; },
    dispatch: async () => { order.push('projection'); throw Object.assign(new Error('temporary'), { code: 'PROJECTION_TEMPORARY' }); }
  });
  assert.deepEqual(order, ['event', 'commit', 'projection']);
  assert.equal(result.status, 'projection_failed');
  assert.equal(result.projection.code, 'PROJECTION_TEMPORARY');
  assert.equal(result.event.envelope.run_id, 'run-1');
  assert.equal(result.event.envelope.parent_event_id, 'user-event-1');
  assert.equal(result.event.envelope.event_status, 'final');
  assert.equal(result.event.envelope.chunk_seq, 4);
  assert.equal(result.event.envelope.resume_cursor, 'run-1:4');
  assert.equal(result.event.envelope.completion_reason, 'stop');
});

test('Finalizer records a content-free failed turn with stream provenance', async () => {
  let failure = null;
  const collector = { collect: async input => { failure = input; return { result: 'accepted_no_store' }; } };
  const finalizer = createInteractionFinalizer({ collector });
  await finalizer.recordFailure({
    context: { tenantId: 'tenant-finalizer', subjectUserId: 'user-finalizer', actorType: 'user', actorId: 'user-finalizer' },
    sessionId: 'session-1',
    runId: 'run-1',
    parentEventId: 'user-event-1',
    stage: 'model',
    code: 'MODEL_UNAVAILABLE',
    retryable: true,
    chunkSeq: 3,
    resumeCursor: 'run-1:3'
  });
  assert.equal(failure.event_type, 'conversation.turn.failed');
  assert.equal(failure.event_status, 'failed');
  assert.equal(failure.privacy_directive, 'do_not_store');
  assert.equal(failure.content, 'conversation turn failed');
  assert.deepEqual(failure.structured_data, { failure_stage: 'model', error_code: 'MODEL_UNAVAILABLE', retryable: true });
  assert.equal(failure.run_id, 'run-1');
  assert.equal(failure.parent_event_id, 'user-event-1');
  assert.equal(failure.chunk_seq, 3);
  assert.equal(failure.resume_cursor, 'run-1:3');
});

test('Finalizer records a superseded assistant event without replaying old content', async () => {
  let superseded = null;
  const collector = { collect: async input => { superseded = input; return { result: 'accepted_no_store' }; } };
  const finalizer = createInteractionFinalizer({ collector });
  await finalizer.recordSuperseded({
    context: { tenantId: 'tenant-finalizer', subjectUserId: 'user-finalizer', actorType: 'user', actorId: 'user-finalizer' },
    sessionId: 'session-1',
    runId: 'run-2',
    parentEventId: 'user-event-2',
    previousMessageId: 'assistant-old',
    supersededBy: 'assistant-new'
  });
  assert.equal(superseded.event_type, 'conversation.assistant_message.completed');
  assert.equal(superseded.event_status, 'superseded');
  assert.equal(superseded.privacy_directive, 'do_not_store');
  assert.equal(superseded.content, 'assistant event superseded');
  assert.deepEqual(superseded.structured_data, { message_id: 'assistant-old', superseded_by: 'assistant-new' });
});
