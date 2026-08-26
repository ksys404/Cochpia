import { randomUUID } from 'node:crypto';
import {
  assertEventDefinition,
  assertProducerContract,
  assertSupportedEventSchemaVersion,
  CANONICAL_EVENT_SCHEMA_VERSION,
  EVENT_CLASSES,
  EVENT_STATUS_VALUES,
  eventDefinition as registryEventDefinition
} from './interaction-schema-registry.js';

export { CANONICAL_EVENT_SCHEMA_VERSION, EVENT_CLASSES, EVENT_DEFINITIONS } from './interaction-schema-registry.js';

const SOURCE_TYPES = new Set(['chat', 'game', 'task', 'calendar', 'music', 'system', 'external']);
const CONTENT_TYPES = new Set(['plain_text', 'structured']);
const PRIVACY_DIRECTIVES = new Set(['default', 'do_not_store', 'do_not_mention']);
const SERVER_DERIVED_FIELDS = new Set([
  'tenant_id', 'tenantId', 'subject_user_id', 'subjectUserId', 'user_id', 'userId',
  'caller_agent_id', 'callerAgentId', 'agent_id', 'agentId', 'actor_type', 'actorType',
  'actor_id', 'actorId', 'relationship_id', 'relationshipId', 'grant', 'grant_id', 'grantId'
]);
const MAX_ID_LENGTH = 200;
const MAX_CONTENT_LENGTH = 12_000;
const MAX_STRUCTURED_DATA_LENGTH = 12_000;
const SECRET_PATTERN = /(?:sk|rk)-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b\d{13,19}\b|\b\d{3}-\d{2}-\d{4}\b/i;

export class InteractionEventError extends Error {
  constructor(code, message, { status = 400 } = {}) {
    super(message);
    this.name = 'InteractionEventError';
    this.code = code;
    this.status = status;
  }
}

const valueOf = (input, snake, camel) => input?.[snake] ?? input?.[camel];

function normalizeId(value, field, { required = true } = {}) {
  const raw = String(value ?? '').trim();
  if (raw.length > MAX_ID_LENGTH) throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `${field} is too long`, { status: 413 });
  const normalized = raw;
  if (!normalized && required) throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `${field} is required`);
  return normalized || null;
}

function normalizeNullable(value, field) {
  return value == null || value === '' ? null : normalizeId(value, field);
}

function normalizeText(value, field, maxLength = MAX_CONTENT_LENGTH, { required = true } = {}) {
  const raw = String(value ?? '').trim();
  if (raw.length > maxLength) throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `${field} is too long`, { status: 413 });
  const normalized = raw;
  if (!normalized && required) throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `${field} is required`);
  return normalized || null;
}

function normalizeDate(value, field, fallback) {
  const candidate = value == null || value === '' ? fallback : value;
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `Invalid ${field}`);
  return date.toISOString();
}

function normalizeBoolean(value, field, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `${field} must be a boolean`);
  return value;
}

function normalizeStructuredData(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InteractionEventError('INVALID_STRUCTURED_DATA', 'structured_data must be an object');
  }
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new InteractionEventError('INVALID_STRUCTURED_DATA', 'structured_data must be JSON serializable'); }
  if (serialized.length > MAX_STRUCTURED_DATA_LENGTH) throw new InteractionEventError('STRUCTURED_DATA_TOO_LARGE', 'structured_data is too large', { status: 413 });
  return structuredClone(value);
}

function assertNoClientIdentityFields(input) {
  const fields = Object.keys(input || {}).filter(field => SERVER_DERIVED_FIELDS.has(field));
  if (fields.length) {
    throw new InteractionEventError('CLIENT_IDENTITY_FIELD_FORBIDDEN', `Client-supplied identity fields are not accepted: ${fields.join(', ')}`, { status: 403 });
  }
}

function contextValue(context, snake, camel, field, { required = true } = {}) {
  return normalizeId(context?.[camel] ?? context?.[snake], field, { required });
}

function normalizeOptionalNumber(value, field) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new InteractionEventError(`INVALID_${field.toUpperCase()}`, `${field} must be a non-negative integer`);
  return number;
}

export function eventDefinition(eventType) {
  return registryEventDefinition(eventType);
}

export function normalizeInteractionEvent(input = {}, context = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InteractionEventError('INVALID_EVENT', 'Event payload must be an object');
  assertNoClientIdentityFields(input);

  let schemaVersion;
  try {
    schemaVersion = assertSupportedEventSchemaVersion(valueOf(input, 'schema_version', 'schemaVersion'));
  } catch (error) {
    throw new InteractionEventError(error.code, error.message, { status: error.status });
  }
  const eventType = normalizeText(valueOf(input, 'event_type', 'eventType'), 'event_type', MAX_ID_LENGTH);
  let definition;
  try {
    definition = assertEventDefinition(eventType, { schemaVersion });
  } catch (error) {
    throw new InteractionEventError(error.code, error.message, { status: error.status });
  }
  if (definition.eventClass === EVENT_CLASSES.INTERNAL && options.allowInternal !== true) {
    throw new InteractionEventError('INTERNAL_EVENT_FORBIDDEN', 'Internal domain events must be published by a trusted dispatcher', { status: 403 });
  }

  const sourceType = normalizeText(options.sourceType ?? valueOf(input, 'source_type', 'sourceType') ?? definition.sourceType, 'source_type', MAX_ID_LENGTH);
  if (!SOURCE_TYPES.has(sourceType)) throw new InteractionEventError('INVALID_SOURCE_TYPE', 'Invalid source_type');
  if (sourceType !== definition.sourceType && !options.allowSourceTypeOverride) throw new InteractionEventError('EVENT_SOURCE_TYPE_MISMATCH', 'source_type does not match event_type');

  const serverTenantId = contextValue(context, 'tenant_id', 'tenantId', 'tenant_id');
  const serverUserId = contextValue(context, 'subject_user_id', 'subjectUserId', 'user_id');
  const serverActorType = normalizeText(context?.actorType ?? context?.actor_type ?? 'user', 'actor_type', 40);
  if (!['user', 'agent', 'system'].includes(serverActorType)) throw new InteractionEventError('INVALID_ACTOR_TYPE', 'Invalid actor_type');
  const serverActorId = contextValue(context, 'actor_id', 'actorId', 'actor_id');
  const serverCallerAgentId = contextValue(context, 'caller_agent_id', 'callerAgentId', 'caller_agent_id', { required: false });
  const serverRelationshipId = contextValue(context, 'relationship_id', 'relationshipId', 'relationship_id', { required: false });
  const serverGrant = context?.grant == null ? null : structuredClone(context.grant);

  const configuredSourceId = options.sourceId ?? context?.sourceId ?? context?.source_id;
  const suppliedSourceId = valueOf(input, 'source_id', 'sourceId');
  if (configuredSourceId != null && suppliedSourceId != null && String(configuredSourceId) !== String(suppliedSourceId)) {
    throw new InteractionEventError('SOURCE_CONTEXT_MISMATCH', 'source_id does not match the server-resolved source', { status: 403 });
  }
  const sourceId = normalizeId(configuredSourceId ?? suppliedSourceId ?? context?.sessionId ?? context?.session_id, 'source_id');

  const configuredSessionId = options.sessionId ?? context?.sessionId ?? context?.session_id;
  const suppliedSessionId = valueOf(input, 'session_id', 'sessionId');
  if (configuredSessionId != null && suppliedSessionId != null && String(configuredSessionId) !== String(suppliedSessionId)) {
    throw new InteractionEventError('SESSION_CONTEXT_MISMATCH', 'session_id does not match the server-resolved session', { status: 403 });
  }
  const sessionId = normalizeNullable(configuredSessionId ?? suppliedSessionId, 'session_id');

  const structuredData = normalizeStructuredData(valueOf(input, 'structured_data', 'structuredData'));
  const rawContent = valueOf(input, 'content', 'content');
  const content = normalizeText(rawContent == null && Object.keys(structuredData).length ? JSON.stringify(structuredData) : rawContent, 'content');
  if (SECRET_PATTERN.test(content) || SECRET_PATTERN.test(JSON.stringify(structuredData))) throw new InteractionEventError('S3_CONTENT_REJECTED', 'Sensitive content cannot enter the interaction event path', { status: 422 });
  const contentType = normalizeText(valueOf(input, 'content_type', 'contentType') ?? 'plain_text', 'content_type', 40);
  if (!CONTENT_TYPES.has(contentType)) throw new InteractionEventError('INVALID_CONTENT_TYPE', 'Invalid content_type');
  const privacyDirective = normalizeText(valueOf(input, 'privacy_directive', 'privacyDirective') ?? 'default', 'privacy_directive', 40);
  if (!PRIVACY_DIRECTIVES.has(privacyDirective)) throw new InteractionEventError('INVALID_PRIVACY_DIRECTIVE', 'Invalid privacy_directive');

  const sourceRevision = normalizeId(valueOf(input, 'source_revision', 'sourceRevision') ?? '1', 'source_revision');
  const configuredIdempotencyKey = valueOf(input, 'idempotency_key', 'idempotencyKey') ?? options.idempotencyKey;
  const eventId = normalizeId(valueOf(input, 'event_id', 'eventId') ?? options.eventId ?? configuredIdempotencyKey ?? `evt_${randomUUID()}`, 'event_id');
  const idempotencyKey = normalizeId(configuredIdempotencyKey ?? `${eventId}:${sourceRevision}`, 'idempotency_key');
  const producerInput = valueOf(input, 'producer', 'producer');
  const producer = normalizeText(options.producer ?? context?.producer ?? producerInput ?? 'unknown', 'producer', MAX_ID_LENGTH);
  if (options.producer && producerInput && String(options.producer) !== String(producerInput)) throw new InteractionEventError('PRODUCER_CONTEXT_MISMATCH', 'producer does not match the trusted adapter');
  if (producerInput != null || options.producer != null || context?.producer != null) {
    try {
      assertProducerContract(eventType, producer, { schemaVersion });
    } catch (error) {
      throw new InteractionEventError(error.code, error.message, { status: error.status });
    }
  }

  const correlationId = normalizeNullable(valueOf(input, 'correlation_id', 'correlationId') ?? options.correlationId, 'correlation_id');
  const causationId = normalizeNullable(valueOf(input, 'causation_id', 'causationId') ?? options.causationId, 'causation_id');
  const occurredAt = normalizeDate(valueOf(input, 'occurred_at', 'occurredAt'), 'occurred_at', options.now ? new Date(options.now) : new Date());
  const receivedAt = normalizeDate(options.receivedAt, 'received_at', options.now ? new Date(options.now) : new Date());
  const isFinal = normalizeBoolean(valueOf(input, 'is_final', 'isFinal'), 'is_final', true);
  const chunkSeq = normalizeOptionalNumber(valueOf(input, 'chunk_seq', 'chunkSeq'), 'chunk_seq');
  const attempt = normalizeOptionalNumber(valueOf(input, 'attempt'), 'attempt');
  const runId = normalizeNullable(valueOf(input, 'run_id', 'runId'), 'run_id');
  const parentEventId = normalizeNullable(valueOf(input, 'parent_event_id', 'parentEventId'), 'parent_event_id');
  const eventStatus = normalizeText(valueOf(input, 'event_status', 'eventStatus') ?? (eventType === 'conversation.turn.failed' ? 'failed' : isFinal ? 'final' : 'partial'), 'event_status', 32);
  if (!EVENT_STATUS_VALUES.includes(eventStatus)) throw new InteractionEventError('INVALID_EVENT_STATUS', 'Invalid event_status');
  if (!definition.allowedStatuses.includes(eventStatus)) throw new InteractionEventError('EVENT_STATUS_FORBIDDEN', `${eventStatus} is not valid for ${eventType}`);
  if (eventStatus === 'partial' && isFinal) throw new InteractionEventError('EVENT_STATUS_MISMATCH', 'partial events must set is_final=false');
  if (eventStatus === 'final' && !isFinal) throw new InteractionEventError('EVENT_STATUS_MISMATCH', 'final events must set is_final=true');
  if (['failed', 'superseded'].includes(eventStatus) && !isFinal) throw new InteractionEventError('EVENT_STATUS_MISMATCH', `${eventStatus} events must set is_final=true`);
  if (eventType === 'conversation.turn.failed' && eventStatus !== 'failed') throw new InteractionEventError('EVENT_STATUS_MISMATCH', 'failed events must use event_status=failed');
  if (eventStatus === 'partial' && !definition.partialAllowed) throw new InteractionEventError('PARTIAL_EVENT_FORBIDDEN', 'This event type cannot be partial');

  return {
    schema_version: schemaVersion,
    event_id: eventId,
    event_type: eventType,
    event_class: definition.eventClass,
    source_type: sourceType,
    source_id: sourceId,
    tenant_id: serverTenantId,
    subject_user_id: serverUserId,
    caller_agent_id: serverCallerAgentId,
    actor_type: serverActorType,
    actor_id: serverActorId,
    relationship_id: serverRelationshipId,
    grant: serverGrant,
    session_id: sessionId,
    occurred_at: occurredAt,
    received_at: receivedAt,
    source_revision: sourceRevision,
    is_final: isFinal,
    event_status: eventStatus,
    run_id: runId,
    parent_event_id: parentEventId,
    content_type: contentType,
    content,
    structured_data: structuredData,
    privacy_directive: privacyDirective,
    idempotency_key: idempotencyKey,
    request_id: context?.requestId ?? context?.request_id ?? null,
    trace_id: context?.traceId ?? context?.trace_id ?? null,
    correlation_id: correlationId,
    causation_id: causationId,
    producer,
    chunk_seq: chunkSeq,
    attempt,
    completion_reason: normalizeNullable(valueOf(input, 'completion_reason', 'completionReason'), 'completion_reason'),
    resume_cursor: normalizeNullable(valueOf(input, 'resume_cursor', 'resumeCursor'), 'resume_cursor')
  };
}

export function toMemoryRecordInput(event, { sessionId = event.session_id } = {}) {
  if (!event || !event.event_id) throw new TypeError('Canonical event is required');
  const definition = eventDefinition(event.event_type);
  const metadata = {
    schema_version: event.schema_version,
    event_type: event.event_type,
    source_type: event.source_type,
    source_id: event.source_id,
    session_id: event.session_id,
    relationship_id: event.relationship_id,
    privacy_directive: event.privacy_directive,
    request_id: event.request_id,
    trace_id: event.trace_id,
    correlation_id: event.correlation_id,
    causation_id: event.causation_id,
    producer: event.producer,
    event_status: event.event_status,
    run_id: event.run_id,
    parent_event_id: event.parent_event_id,
    received_at: event.received_at,
    chunk_seq: event.chunk_seq,
    attempt: event.attempt,
    completion_reason: event.completion_reason,
    resume_cursor: event.resume_cursor
  };
  return {
    eventId: event.event_id,
    sourceRevision: event.source_revision,
    sessionId: sessionId || null,
    turnId: event.correlation_id || event.event_id,
    sequenceNo: event.chunk_seq,
    eventRole: definition?.eventRole || (event.event_class === EVENT_CLASSES.INTERNAL ? 'system' : 'user'),
    contentType: event.content_type,
    content: event.content,
    metadata,
    occurredAt: event.occurred_at,
    isStreamFinal: event.is_final,
    storageDirective: event.privacy_directive === 'do_not_store' ? 'do_not_store' : 'default'
  };
}

export { SERVER_DERIVED_FIELDS };
