import { randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);
const clampScore = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const stageFor = score => score >= 80 ? 'close' : score >= 60 ? 'familiar' : score >= 35 ? 'forming' : 'distant';
const relationshipIdFor = agentId => `relationship:${agentId}`;

function normalize(record = {}, agentId, now = () => new Date()) {
  const score = clampScore(record.score ?? 50);
  return {
    id: record.id || relationshipIdFor(agentId),
    agentId,
    stage: ['distant', 'forming', 'familiar', 'close'].includes(record.stage) ? record.stage : stageFor(score),
    score,
    interactionCount: Math.max(0, Math.floor(Number(record.interactionCount) || 0)),
    signals: Array.isArray(record.signals) ? record.signals.slice(0, 100) : [],
    sourceEventIds: Array.isArray(record.sourceEventIds) ? [...new Set(record.sourceEventIds.map(String))].slice(0, 200) : [],
    appliedEventIds: Array.isArray(record.appliedEventIds) ? [...new Set(record.appliedEventIds.map(String))].slice(0, 200) : [],
    projectionStatus: record.projectionStatus === 'needs_rebuild' ? 'needs_rebuild' : null,
    resourceRevision: Math.max(1, Math.floor(Number(record.resourceRevision) || 1)),
    updatedAt: record.updatedAt || new Date(now()).toISOString()
  };
}

export function createRelationshipStateService(state, persist = async () => {}, { now = () => new Date() } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Relationship state storage is required');
  state.relationshipStates ||= {};

  const ensure = agentId => {
    const normalizedAgentId = String(agentId || 'cochpia').trim().slice(0, 200) || 'cochpia';
    state.relationshipStates[normalizedAgentId] = normalize(state.relationshipStates[normalizedAgentId], normalizedAgentId, now);
    return state.relationshipStates[normalizedAgentId];
  };
  const get = agentId => clone(ensure(agentId));
  const relationshipId = agentId => ensure(agentId).id;

  const observe = async (agentId, input = {}) => {
    const record = ensure(agentId);
    const eventId = String(input.eventId || input.event_id || '').trim();
    if (!eventId) throw Object.assign(new Error('Relationship signal eventId is required'), { code: 'RELATIONSHIP_EVENT_ID_REQUIRED', status: 400 });
    if (record.appliedEventIds.includes(eventId)) return { state: get(agentId), duplicate: true, signal: record.signals.find(item => item.eventId === eventId) || null };
    if (input.expectedRevision != null && Number(input.expectedRevision) !== record.resourceRevision) {
      throw Object.assign(new Error('Relationship state revision is stale'), { code: 'RELATIONSHIP_REVISION_CONFLICT', status: 409, currentResourceRevision: record.resourceRevision });
    }
    const delta = Math.max(-10, Math.min(10, Math.round(Number(input.delta) || 0)));
    const occurredAt = new Date(now()).toISOString();
    const previous = clone(record);
    const signal = {
      id: input.signalId || randomUUID(),
      eventId,
      sourceEventId: input.sourceEventId || input.source_event_id || null,
      signalType: String(input.signalType || input.signal_type || 'interaction').slice(0, 100),
      delta,
      evidence: String(input.evidence || '').slice(0, 300),
      occurredAt
    };
    record.score = clampScore(record.score + delta);
    record.stage = stageFor(record.score);
    record.interactionCount += 1;
    record.resourceRevision += 1;
    record.updatedAt = occurredAt;
    record.signals = [signal, ...record.signals].slice(0, 100);
    record.sourceEventIds = [...new Set([signal.sourceEventId, ...record.sourceEventIds].filter(Boolean))].slice(0, 200);
    record.appliedEventIds = [eventId, ...record.appliedEventIds].slice(0, 200);
    try {
      await persist();
    } catch (error) {
      state.relationshipStates[record.agentId] = previous;
      throw error;
    }
    return { state: clone(record), duplicate: false, signal: clone(signal) };
  };

  const redactSourceEvent = async (agentId, sourceEventId) => {
    const record = ensure(agentId);
    const normalizedSourceEventId = String(sourceEventId || '').trim();
    if (!normalizedSourceEventId) return { state: get(agentId), removed: 0, invalidated: false };
    const affectedSignals = record.signals.filter(signal => signal.sourceEventId === normalizedSourceEventId);
    const previous = clone(record);
    record.signals = record.signals.filter(signal => signal.sourceEventId !== normalizedSourceEventId);
    record.sourceEventIds = record.sourceEventIds.filter(id => id !== normalizedSourceEventId);
    record.appliedEventIds = record.appliedEventIds.filter(eventId => !affectedSignals.some(signal => signal.eventId === eventId));
    record.score = clampScore(record.score - affectedSignals.reduce((sum, signal) => sum + Number(signal.delta || 0), 0));
    record.interactionCount = Math.max(0, record.interactionCount - affectedSignals.length);
    record.stage = stageFor(record.score);
    record.resourceRevision += 1;
    record.updatedAt = new Date(now()).toISOString();
    if (!affectedSignals.length && previous.sourceEventIds.includes(normalizedSourceEventId)) record.projectionStatus = 'needs_rebuild';
    try {
      await persist();
    } catch (error) {
      state.relationshipStates[record.agentId] = previous;
      throw error;
    }
    return { state: get(agentId), removed: affectedSignals.length, invalidated: Boolean(record.projectionStatus === 'needs_rebuild') };
  };

  return { ensure, get, list: () => Object.values(state.relationshipStates).map(clone), relationshipId, observe, redactSourceEvent };
}

export { relationshipIdFor, stageFor };
