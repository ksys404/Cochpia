export const EVENT_SCHEMA_REGISTRY_VERSION = 1;
export const CANONICAL_EVENT_SCHEMA_VERSION = 1;

export const EVENT_CLASSES = Object.freeze({
  INGRESS: 'ingress',
  INTERNAL: 'internal'
});

export const EVENT_STATUS_VALUES = Object.freeze(['partial', 'final', 'failed', 'superseded']);

const definition = ({ sourceType, eventClass, eventRole, producers, consumers, partialAllowed = false, allowedStatuses = partialAllowed ? ['partial', 'final'] : ['final'] }) => Object.freeze({
  sourceType,
  eventClass,
  eventRole,
  introducedIn: CANONICAL_EVENT_SCHEMA_VERSION,
  deprecatedIn: null,
  producers: Object.freeze([...producers]),
  consumers: Object.freeze([...consumers]),
  partialAllowed,
  allowedStatuses: Object.freeze([...allowedStatuses]),
  occurredAtSemantics: 'occurred_at is the source event time; received_at is assigned by the server at ingress'
});

export const EVENT_DEFINITIONS = Object.freeze({
  'conversation.user_message.created': definition({ sourceType: 'chat', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['chat-adapter'], consumers: ['memory-module', 'relationship-projection'], partialAllowed: true }),
  'conversation.assistant_message.completed': definition({ sourceType: 'chat', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'agent', producers: ['chat-finalizer'], consumers: ['memory-module', 'relationship-projection', 'personality-projection'], allowedStatuses: ['final', 'superseded'] }),
  'conversation.turn.failed': definition({ sourceType: 'chat', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['chat-finalizer'], consumers: ['memory-module', 'observability'], allowedStatuses: ['failed'] }),
  'life.action.completed': definition({ sourceType: 'game', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['life-adapter'], consumers: ['memory-module', 'life-state', 'relationship-projection'] }),
  'life.decision.resolved': definition({ sourceType: 'game', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['life-adapter'], consumers: ['memory-module', 'life-state', 'relationship-projection'] }),
  'life.state.reset': definition({ sourceType: 'game', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['life-adapter'], consumers: ['memory-module', 'life-state'] }),
  'life.mode.changed': definition({ sourceType: 'game', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['life-adapter'], consumers: ['memory-module', 'life-state'] }),
  'task.created': definition({ sourceType: 'task', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['task-adapter'], consumers: ['memory-module', 'task-state'] }),
  'task.updated': definition({ sourceType: 'task', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['task-adapter'], consumers: ['memory-module', 'task-state'] }),
  'task.deleted': definition({ sourceType: 'task', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['task-adapter'], consumers: ['memory-module', 'task-state'] }),
  'calendar.event.created': definition({ sourceType: 'calendar', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['calendar-adapter'], consumers: ['memory-module', 'calendar-state'] }),
  'calendar.event.updated': definition({ sourceType: 'calendar', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['calendar-adapter'], consumers: ['memory-module', 'calendar-state'] }),
  'calendar.event.deleted': definition({ sourceType: 'calendar', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['calendar-adapter'], consumers: ['memory-module', 'calendar-state'] }),
  'music.playback.changed': definition({ sourceType: 'music', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['music-adapter'], consumers: ['memory-module', 'music-adapter'] }),
  'memory.write.requested': definition({ sourceType: 'external', eventClass: EVENT_CLASSES.INGRESS, eventRole: 'user', producers: ['mcp-adapter', 'memory-api-adapter'], consumers: ['memory-module', 'audit'] }),
  'relationship.signal.observed': definition({ sourceType: 'system', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['relationship-projection'], consumers: ['relationship-projection', 'personality-projection'] }),
  'memory.candidate.created': definition({ sourceType: 'system', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['memory-module'], consumers: ['memory-module', 'observability'] }),
  'memory.assertion.promoted': definition({ sourceType: 'system', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['memory-module'], consumers: ['profile-projection', 'personality-projection'] }),
  'memory.governance.changed': definition({ sourceType: 'system', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['memory-module'], consumers: ['projection-dispatcher', 'audit'] }),
  'personality.evidence.created': definition({ sourceType: 'system', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['personality-projection'], consumers: ['personality-projection', 'context-builder'] }),
  'state.current.updated': definition({ sourceType: 'system', eventClass: EVENT_CLASSES.INTERNAL, eventRole: 'system', producers: ['state-projection'], consumers: ['context-builder', 'memory-module'] })
});

export const EVENT_FIELD_CLASSIFICATIONS = Object.freeze({
  schema_version: 'protocol',
  event_id: 'identifier',
  event_type: 'protocol',
  event_class: 'protocol',
  source_type: 'routing',
  source_id: 'identifier',
  tenant_id: 'identity',
  subject_user_id: 'identity',
  caller_agent_id: 'identity',
  actor_type: 'identity',
  actor_id: 'identity',
  relationship_id: 'relationship',
  session_id: 'identifier',
  occurred_at: 'timestamp',
  received_at: 'timestamp',
  source_revision: 'ordering',
  is_final: 'stream_state',
  event_status: 'stream_state',
  run_id: 'identifier',
  parent_event_id: 'identifier',
  chunk_seq: 'ordering',
  attempt: 'retry',
  completion_reason: 'outcome',
  resume_cursor: 'cursor',
  content_type: 'content_metadata',
  content: 'content',
  structured_data: 'content_metadata',
  privacy_directive: 'policy',
  idempotency_key: 'idempotency',
  request_id: 'trace',
  trace_id: 'trace',
  correlation_id: 'trace',
  causation_id: 'trace',
  producer: 'producer'
});

export const EVENT_SCHEMA_COMPATIBILITY = Object.freeze({
  1: Object.freeze({
    status: 'current',
    readableVersions: Object.freeze([1]),
    writableVersions: Object.freeze([1]),
    deprecationDate: null
  })
});

export class EventSchemaRegistryError extends Error {
  constructor(code, message, { status = 422 } = {}) {
    super(message);
    this.name = 'EventSchemaRegistryError';
    this.code = code;
    this.status = status;
  }
}

export function eventDefinition(eventType) {
  return EVENT_DEFINITIONS[eventType] || null;
}

export function classifyEventField(field) {
  return EVENT_FIELD_CLASSIFICATIONS[field] || null;
}

export function assertSupportedEventSchemaVersion(value, { mode = 'write' } = {}) {
  const version = value == null || value === '' ? CANONICAL_EVENT_SCHEMA_VERSION : Number(value);
  if (!Number.isSafeInteger(version)) throw new EventSchemaRegistryError('INVALID_EVENT_SCHEMA_VERSION', 'schema_version must be an integer');
  const compatibility = EVENT_SCHEMA_COMPATIBILITY[version];
  const versions = compatibility?.[mode === 'read' ? 'readableVersions' : 'writableVersions'];
  if (!versions?.includes(version)) throw new EventSchemaRegistryError('UNSUPPORTED_EVENT_SCHEMA_VERSION', `Unsupported event schema version: ${version}`);
  return version;
}

export function assertEventDefinition(eventType, { schemaVersion = CANONICAL_EVENT_SCHEMA_VERSION } = {}) {
  const definitionValue = eventDefinition(eventType);
  if (!definitionValue) throw new EventSchemaRegistryError('UNKNOWN_EVENT_TYPE', `Unsupported event_type: ${eventType}`);
  if (definitionValue.introducedIn > schemaVersion || (definitionValue.deprecatedIn && schemaVersion >= definitionValue.deprecatedIn)) {
    throw new EventSchemaRegistryError('EVENT_SCHEMA_INCOMPATIBLE', `event_type is incompatible with schema version ${schemaVersion}`);
  }
  return definitionValue;
}

export function assertProducerContract(eventType, producer, { allowUnknown = true, schemaVersion = CANONICAL_EVENT_SCHEMA_VERSION } = {}) {
  const definitionValue = assertEventDefinition(eventType, { schemaVersion });
  const normalized = String(producer || '').trim();
  if (!normalized && allowUnknown) return definitionValue;
  if (allowUnknown && normalized === 'unknown') return definitionValue;
  if (!definitionValue.producers.includes(normalized)) {
    throw new EventSchemaRegistryError('EVENT_PRODUCER_FORBIDDEN', `${normalized} cannot publish ${eventType}`, { status: 403 });
  }
  return definitionValue;
}
