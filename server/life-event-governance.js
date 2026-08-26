import { randomUUID } from 'node:crypto';

const clone = value => value == null ? value : structuredClone(value);
const allowedActions = new Set(['forget', 'delete']);

function normalizeAction(action) {
  const value = String(action || '').trim();
  if (!allowedActions.has(value)) throw new Error('Life event governance action must be forget or delete');
  return value;
}

function normalizeId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized.slice(0, 240);
}

function iso(now) {
  return new Date(now).toISOString();
}

function operationStatus(operation) {
  if (operation.memoryStatus === 'completed' && operation.projectionStatus === 'completed') return 'completed';
  if (operation.lastErrorCode) return 'failed';
  if (operation.memoryStatus === 'completed') return 'projection_pending';
  return 'pending';
}

export function ensureLifeEventGovernanceState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Life event governance state is required');
  state.companion ||= {};
  state.companion.lifeEventGovernance ||= [];
  if (!Array.isArray(state.companion.lifeEventGovernance)) state.companion.lifeEventGovernance = [];
  return state.companion.lifeEventGovernance;
}

export function findLifeEventGovernance(state, { action, identifier, operationId } = {}) {
  const operations = ensureLifeEventGovernanceState(state);
  if (operationId) return operations.find(operation => operation.id === String(operationId)) || null;
  const value = normalizeId(identifier, 'life_event_identifier');
  const normalizedAction = action == null ? null : normalizeAction(action);
  return operations.find(operation => operation.action === normalizedAction
    && (operation.rawEventId === value || operation.eventId === value))
    || (normalizedAction == null
      ? operations.find(operation => operation.rawEventId === value || operation.eventId === value) || null
      : null);
}

export function beginLifeEventGovernance(state, { action, rawEvent, idempotencyKey = null, now = new Date() } = {}) {
  const normalizedAction = normalizeAction(action);
  const rawEventId = normalizeId(rawEvent?.id, 'raw_event_id');
  const eventId = normalizeId(rawEvent?.eventId, 'event_id');
  const operations = ensureLifeEventGovernanceState(state);
  const existing = operations.find(operation => operation.action === normalizedAction && operation.rawEventId === rawEventId);
  if (existing) return { operation: clone(existing), duplicate: true };

  const timestamp = iso(now);
  const operation = {
    id: randomUUID(),
    kind: 'life_event_governance',
    action: normalizedAction,
    rawEventId,
    eventId,
    idempotencyKey: idempotencyKey ? String(idempotencyKey).slice(0, 200) : null,
    status: 'pending',
    memoryStatus: 'pending',
    projectionStatus: 'pending',
    attempts: 1,
    requestedAt: timestamp,
    lastAttemptAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    memoryDeletion: null,
    projections: null,
    lastErrorCode: null,
    lastErrorStep: null
  };
  operations.unshift(operation);
  return { operation: clone(operation), duplicate: false };
}

export function markLifeEventGovernanceStep(state, operationId, {
  memoryStatus,
  projectionStatus,
  memoryDeletion,
  projections,
  errorCode = null,
  errorStep = null,
  now = new Date()
} = {}) {
  const operations = ensureLifeEventGovernanceState(state);
  const operation = operations.find(item => item.id === String(operationId));
  if (!operation) throw new Error('Life event governance operation not found');
  if (memoryStatus) operation.memoryStatus = String(memoryStatus);
  if (projectionStatus) operation.projectionStatus = String(projectionStatus);
  if (memoryDeletion !== undefined) operation.memoryDeletion = clone(memoryDeletion);
  if (projections !== undefined) operation.projections = clone(projections);
  operation.lastErrorCode = errorCode ? String(errorCode).slice(0, 160) : null;
  operation.lastErrorStep = errorStep ? String(errorStep).slice(0, 80) : null;
  operation.status = operationStatus(operation);
  operation.updatedAt = iso(now);
  operation.completedAt = operation.status === 'completed' ? (operation.completedAt || operation.updatedAt) : null;
  return clone(operation);
}

export function touchLifeEventGovernance(state, operationId, { idempotencyKey = null, now = new Date() } = {}) {
  const operations = ensureLifeEventGovernanceState(state);
  const operation = operations.find(item => item.id === String(operationId));
  if (!operation) throw new Error('Life event governance operation not found');
  if (operation.status === 'completed') return clone(operation);
  operation.attempts = Math.max(1, Number(operation.attempts) || 0) + 1;
  operation.lastAttemptAt = iso(now);
  if (idempotencyKey && !operation.idempotencyKey) operation.idempotencyKey = String(idempotencyKey).slice(0, 200);
  operation.lastErrorCode = null;
  operation.lastErrorStep = null;
  operation.status = operationStatus(operation);
  operation.updatedAt = iso(now);
  return clone(operation);
}

export function recordLifeEventGovernanceFailure(state, operationId, { errorCode, errorStep, now = new Date() } = {}) {
  return markLifeEventGovernanceStep(state, operationId, { errorCode, errorStep, now });
}

function memoryStateOf(memoryOrState) {
  return memoryOrState?.state && typeof memoryOrState.state === 'object' ? memoryOrState.state : (memoryOrState || {});
}

function sourceEventTombstone(memoryState, operation) {
  return (memoryState.tombstones || [])
    .filter(item => item.targetType === 'source_event' && item.targetId === operation.rawEventId && item.action === operation.action)
    .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))[0] || null;
}

export function reconcileLifeEventGovernance({ state, memory, operation, now = new Date() } = {}) {
  if (!operation) throw new Error('Life event governance operation is required');
  const memoryState = memoryStateOf(memory);
  const rawEventPresent = (memoryState.rawEvents || []).some(item => item.id === operation.rawEventId);
  const tombstone = sourceEventTombstone(memoryState, operation);
  const expectedRawEventPresent = operation.action === 'forget';
  const memoryOk = Boolean(tombstone) && rawEventPresent === expectedRawEventPresent;
  const lifeState = state?.lifeState || {};
  const eventIds = new Set([operation.eventId]);
  const lifeStateLeaks = [
    ...(lifeState.commandLog || []).filter(item => item.rawEventId === operation.rawEventId || eventIds.has(item.eventId)),
    ...(lifeState.recentEvents || []).filter(item => eventIds.has(item.id)),
    ...(lifeState.currentEvent && eventIds.has(lifeState.currentEvent.id) ? [lifeState.currentEvent] : [])
  ];
  const evidenceLeaks = (state?.evidence || []).filter(item => item.sourceEventId === operation.rawEventId);
  const relationshipLeaks = Object.values(state?.relationshipStates || {}).flatMap(record =>
    (record.signals || []).filter(signal => signal.sourceEventId === operation.rawEventId)
  );
  const personalityLeaks = [
    ...(state?.personalityProjection?.appliedSourceEventIds || []).filter(item => item === operation.rawEventId),
    ...(state?.personalityHistory || []).filter(item => item.sourceEventId === operation.rawEventId || item.sourceEvidenceEventId === operation.rawEventId)
  ];
  const personalityAuditReferences = (state?.personalityAudit || []).filter(item => item.sourceEventId === operation.rawEventId);
  const projectionsOk = lifeStateLeaks.length === 0
    && evidenceLeaks.length === 0
    && relationshipLeaks.length === 0
    && personalityLeaks.length === 0;
  const report = {
    operationId: operation.id,
    action: operation.action,
    rawEventId: operation.rawEventId,
    eventId: operation.eventId,
    checkedAt: iso(now),
    memory: {
      ok: memoryOk,
      rawEventPresent,
      expectedRawEventPresent,
      tombstoneAction: tombstone?.action || null,
      tombstoneId: tombstone?.id || null
    },
    projections: {
      ok: projectionsOk,
      lifeStateLeaks: lifeStateLeaks.length,
      evidenceLeaks: evidenceLeaks.length,
      relationshipLeaks: relationshipLeaks.length,
      personalityLeaks: personalityLeaks.length,
      personalityAuditReferences: personalityAuditReferences.length
    }
  };
  report.complete = report.memory.ok && report.projections.ok;
  report.repairNeeded = !report.complete;
  return report;
}

export function listLifeEventGovernance(state, { status } = {}) {
  const operations = ensureLifeEventGovernanceState(state);
  return operations
    .filter(operation => !status || operation.status === status)
    .map(clone);
}
