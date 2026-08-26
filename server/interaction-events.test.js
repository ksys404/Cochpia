import test from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_CLASSES, InteractionEventError, normalizeInteractionEvent, toMemoryRecordInput } from './interaction-events.js';
import { EVENT_SCHEMA_COMPATIBILITY, EVENT_STATUS_VALUES, classifyEventField } from './interaction-schema-registry.js';

const context = {
  tenantId: 'tenant-events',
  subjectUserId: 'user-events',
  actorType: 'user',
  actorId: 'user-events',
  callerAgentId: 'cochpia',
  relationshipId: 'relationship-1',
  requestId: 'request-1',
  traceId: 'trace-1'
};

test('canonical event derives identity from the verified context', () => {
  const event = normalizeInteractionEvent({
    event_type: 'conversation.user_message.created',
    source_type: 'chat',
    source_id: 'session-1',
    session_id: 'session-1',
    content: '我喜欢桂花乌龙',
    idempotency_key: 'idem-1'
  }, context, { producer: 'chat-adapter', sessionId: 'session-1', sourceId: 'session-1' });
  assert.equal(event.schema_version, 1);
  assert.equal(event.event_class, EVENT_CLASSES.INGRESS);
  assert.equal(event.tenant_id, 'tenant-events');
  assert.equal(event.subject_user_id, 'user-events');
  assert.equal(event.actor_id, 'user-events');
  assert.equal(event.request_id, 'request-1');
  assert.equal(event.producer, 'chat-adapter');
});

test('idempotency-only submissions receive a stable event id', () => {
  const event = normalizeInteractionEvent({
    event_type: 'conversation.user_message.created',
    source_type: 'chat',
    source_id: 'session-1',
    content: 'retryable',
    idempotency_key: 'retry-key-1'
  }, context);
  assert.equal(event.event_id, 'retry-key-1');
  assert.equal(event.idempotency_key, 'retry-key-1');
});

test('client identity fields are rejected instead of trusted', () => {
  assert.throws(
    () => normalizeInteractionEvent({ event_type: 'conversation.user_message.created', source_id: 'session-1', content: 'safe', user_id: 'attacker' }, context),
    error => error instanceof InteractionEventError && error.code === 'CLIENT_IDENTITY_FIELD_FORBIDDEN'
  );
});

test('internal events require a trusted dispatcher', () => {
  assert.throws(
    () => normalizeInteractionEvent({ event_type: 'conversation.assistant_message.completed', source_type: 'chat', source_id: 'session-1', content: 'reply' }, context),
    error => error.code === 'INTERNAL_EVENT_FORBIDDEN'
  );
  const event = normalizeInteractionEvent({ event_type: 'conversation.assistant_message.completed', source_type: 'chat', source_id: 'session-1', content: 'reply' }, context, { allowInternal: true });
  assert.equal(event.event_class, EVENT_CLASSES.INTERNAL);
});

test('privacy, stream, and canonical metadata survive the Memory projection', () => {
  const event = normalizeInteractionEvent({
    event_type: 'conversation.user_message.created',
    source_type: 'chat',
    source_id: 'session-1',
    content: 'partial',
    privacy_directive: 'do_not_mention',
    is_final: false,
    chunk_seq: 2,
    completion_reason: 'partial',
    run_id: 'run-1',
    parent_event_id: 'event-parent-1',
    event_status: 'partial'
  }, context);
  const stored = toMemoryRecordInput(event, { sessionId: null });
  assert.equal(stored.storageDirective, 'default');
  assert.equal(stored.isStreamFinal, false);
  assert.equal(stored.metadata.privacy_directive, 'do_not_mention');
  assert.equal(stored.metadata.chunk_seq, 2);
  assert.equal(stored.metadata.run_id, 'run-1');
  assert.equal(stored.metadata.parent_event_id, 'event-parent-1');
  assert.equal(stored.metadata.event_status, 'partial');
  assert.equal(stored.metadata.received_at, stored.occurredAt || event.received_at);
});

test('event schema registry exposes field classification and compatibility evidence', () => {
  assert.deepEqual(EVENT_SCHEMA_COMPATIBILITY[1].writableVersions, [1]);
  assert.equal(EVENT_STATUS_VALUES.includes('superseded'), true);
  assert.equal(classifyEventField('subject_user_id'), 'identity');
  assert.equal(classifyEventField('content'), 'content');
  assert.equal(classifyEventField('unknown_field'), null);
});

test('canonical event rejects unsupported schema versions and inconsistent stream status', () => {
  assert.throws(
    () => normalizeInteractionEvent({ schema_version: 2, event_type: 'conversation.user_message.created', source_id: 'session-1', content: 'hello' }, context),
    error => error instanceof InteractionEventError && error.code === 'UNSUPPORTED_EVENT_SCHEMA_VERSION'
  );
  assert.throws(
    () => normalizeInteractionEvent({ event_type: 'conversation.user_message.created', source_id: 'session-1', content: 'hello', is_final: true, event_status: 'partial' }, context),
    error => error instanceof InteractionEventError && error.code === 'EVENT_STATUS_MISMATCH'
  );
  assert.throws(
    () => normalizeInteractionEvent({ event_type: 'conversation.user_message.created', source_id: 'session-1', content: 'hello', event_status: 'superseded' }, context),
    error => error instanceof InteractionEventError && error.code === 'EVENT_STATUS_FORBIDDEN'
  );
});

test('event producer contracts reject a producer from another boundary', () => {
  assert.throws(
    () => normalizeInteractionEvent({ event_type: 'conversation.user_message.created', source_id: 'session-1', content: 'hello', producer: 'chat-finalizer' }, context),
    error => error instanceof InteractionEventError && error.code === 'EVENT_PRODUCER_FORBIDDEN'
  );
});

test('canonical ingress rejects secret-like content in structured data before storage', () => {
  assert.throws(
    () => normalizeInteractionEvent({
      event_type: 'life.action.completed',
      source_type: 'game',
      source_id: 'life-1',
      content: 'safe event',
      structured_data: { note: 'AKIA1234567890ABCDEF' }
    }, context),
    error => error.code === 'S3_CONTENT_REJECTED'
  );
});

test('auxiliary product adapters use registered ingress event contracts', () => {
  for (const [eventType, sourceType, producer] of [
    ['task.created', 'task', 'task-adapter'],
    ['calendar.event.created', 'calendar', 'calendar-adapter'],
    ['music.playback.changed', 'music', 'music-adapter'],
    ['memory.write.requested', 'external', 'memory-api-adapter']
  ]) {
    const event = normalizeInteractionEvent({
      event_type: eventType,
      source_type: sourceType,
      source_id: `${sourceType}-1`,
      content_type: 'structured',
      content: `${eventType} smoke`,
      structured_data: { source_type: sourceType },
      producer
    }, context);
    assert.equal(event.event_class, EVENT_CLASSES.INGRESS);
    assert.equal(event.source_type, sourceType);
    assert.equal(event.producer, producer);
  }
});

test('MCP memory writes use an external ingress contract', () => {
  const event = normalizeInteractionEvent({
    event_type: 'memory.write.requested',
    source_type: 'external',
    source_id: 'mcp:hold',
    content_type: 'structured',
    content: 'MCP write request: hold',
    structured_data: { tool: 'hold' },
    producer: 'mcp-adapter'
  }, context);
  assert.equal(event.event_class, EVENT_CLASSES.INGRESS);
  assert.equal(event.source_type, 'external');
  assert.equal(event.producer, 'mcp-adapter');
});
