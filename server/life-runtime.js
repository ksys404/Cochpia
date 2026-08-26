import {
  beginLifeEventGovernance,
  findLifeEventGovernance,
  markLifeEventGovernanceStep,
  reconcileLifeEventGovernance,
  recordLifeEventGovernanceFailure,
  touchLifeEventGovernance
} from './life-event-governance.js';
import { redactLifeEventProvenance } from './life-event-projection.js';

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`);
}
function requireObject(value, name) {
  if (!value || typeof value !== 'object') throw new TypeError(`${name} is required`);
}

/**
 * Runtime boundary for LifeState event delivery and source-event governance.
 * The state machine remains in life-state.js and the durable governance record
 * remains in life-event-governance.js; this module only coordinates the
 * request-scoped Memory Module and product projections.
 */
export function createCompanionLifeRuntime({
  state,
  persist = async () => {},
  memoryRuntime,
  relationships,
  personalityProjection,
  redactProvenance = redactLifeEventProvenance
} = {}) {
  requireObject(state, 'Life runtime state');
  requireFunction(persist, 'Life runtime persist');
  if (!memoryRuntime?.prepareForRequest || !memoryRuntime?.contextFromRequest) {
    throw new TypeError('Life runtime Memory Module runtime is required');
  }
  if (!relationships?.get || !relationships?.redactSourceEvent) {
    throw new TypeError('Life runtime relationship service is required');
  }
  if (!personalityProjection?.rebuildFromConfirmedEvidence) {
    throw new TypeError('Life runtime personality projection is required');
  }
  requireFunction(redactProvenance, 'Life runtime provenance redactor');

  const findGameRawEvent = (memory, identifier) => {
    const value = String(identifier || '').trim();
    return (memory?.state?.rawEvents || []).find(event =>
      (event.id === value || event.eventId === value) && event.metadata?.source_type === 'game'
    );
  };

  const completedLifeMemoryGovernance = (memory, operation) => {
    const memoryState = memory?.state || {};
    const rawEventPresent = (memoryState.rawEvents || []).some(item => item.id === operation.rawEventId);
    const tombstone = (memoryState.tombstones || [])
      .filter(item => item.targetType === 'source_event'
        && item.targetId === operation.rawEventId
        && item.action === operation.action)
      .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0))[0] || null;
    const expectedRawEventPresent = operation.action === 'forget';
    if (!tombstone || rawEventPresent !== expectedRawEventPresent) return null;
    const deletion = (memoryState.deletionOperations || [])
      .filter(item => item.targetType === 'source_event'
        && item.targetId === operation.rawEventId
        && item.action === operation.action)
      .sort((left, right) => new Date(right.requestedAt || 0) - new Date(left.requestedAt || 0))[0] || null;
    return {
      sourceEventId: operation.rawEventId,
      deletionOperationId: deletion?.id || null,
      status: operation.action === 'forget' ? 'forgotten' : 'completed',
      redactionEpoch: deletion?.redactionEpoch || tombstone.redactionEpoch || null,
      consistencyToken: null,
      recoveredFromTombstone: true
    };
  };

  const governanceRawEvent = (memory, operation, identifier) => findGameRawEvent(memory, identifier) || (operation
    ? { id: operation.rawEventId, eventId: operation.eventId, resourceRevision: 1, metadata: { source_type: 'game' } }
    : null);

  const redactLifeEvent = async (rawEvent, action) => {
    const projection = redactProvenance(state, { rawEventId: rawEvent.id, eventId: rawEvent.eventId });
    const relationship = await relationships.redactSourceEvent('cochpia', rawEvent.id);
    let personality = null;
    if (projection.removedEvidenceIds.length) {
      personality = await personalityProjection.rebuildFromConfirmedEvidence({
        excludedSourceEventIds: [rawEvent.id],
        source: `life_event_${action}`
      });
    } else {
      await persist();
    }
    return { projection, relationship, personality };
  };

  const lifeStateForResponse = rawState => ({
    ...rawState,
    relationship: relationships.get('cochpia').score,
    relationshipStage: relationships.get('cochpia').stage
  });

  const sendLifeEventResponse = (res, result, event) => {
    const payload = {
      state: lifeStateForResponse(result.state),
      duplicate: result.duplicate,
      event: {
        id: result.event.eventId,
        status: event.status,
        rawEventId: event.rawEventId || null,
        errorCode: event.errorCode || null
      }
    };
    if (event.status === 'dead_letter') {
      return res.status(503).json({
        error: { code: 'LIFE_EVENT_DEAD_LETTER', message: 'Life event delivery reached its retry limit and requires operator repair' },
        ...payload
      });
    }
    return res.status(['pending', 'processing'].includes(event.status) ? 202 : 200).json(payload);
  };

  const runLifeEventGovernance = async (req, { action, identifier, operationId = null, idempotencyKey = null } = {}) => {
    const memory = await memoryRuntime.prepareForRequest(req);
    const context = memoryRuntime.contextFromRequest(req);
    let operation = operationId
      ? findLifeEventGovernance(state, { operationId })
      : findLifeEventGovernance(state, { action, identifier });
    let rawEvent = governanceRawEvent(memory, operation, identifier);
    if (!operation && !rawEvent) throw Object.assign(new Error('Game event not found'), { code: 'LIFE_EVENT_NOT_FOUND', status: 404 });

    if (!operation) {
      operation = beginLifeEventGovernance(state, { action, rawEvent, idempotencyKey }).operation;
      await persist();
    } else if (operation.status !== 'completed') {
      operation = touchLifeEventGovernance(state, operation.id, { idempotencyKey });
      await persist();
      rawEvent = governanceRawEvent(memory, operation, identifier);
    }

    if (operation.status === 'completed') {
      const reconciliation = reconcileLifeEventGovernance({ state, memory, operation });
      if (reconciliation.complete) return { operation, reconciliation, memoryDeletion: operation.memoryDeletion, projections: operation.projections };
      operation = markLifeEventGovernanceStep(state, operation.id, {
        projectionStatus: 'pending',
        errorCode: 'LIFE_EVENT_RECONCILIATION_INCOMPLETE',
        errorStep: 'reconciliation'
      });
      await persist();
    }

    let memoryDeletion = operation.memoryDeletion;
    if (operation.memoryStatus !== 'completed') {
      memoryDeletion = completedLifeMemoryGovernance(memory, operation);
      try {
        if (!memoryDeletion) {
          if (!rawEvent) throw Object.assign(new Error('Game event not found'), { code: 'LIFE_EVENT_NOT_FOUND', status: 404 });
          memoryDeletion = operation.action === 'forget'
            ? await memory.forgetSourceEvent(context, rawEvent.id, {
              resourceRevision: rawEvent.resourceRevision || 1,
              idempotency_key: idempotencyKey || `life-event-forget:${rawEvent.id}`
            })
            : await memory.deleteSourceEvent(context, rawEvent.id, {
              resourceRevision: rawEvent.resourceRevision || 1,
              idempotency_key: idempotencyKey || `life-event-delete:${rawEvent.id}`
            });
        }
        operation = markLifeEventGovernanceStep(state, operation.id, { memoryStatus: 'completed', memoryDeletion });
        await persist();
      } catch (error) {
        const recovered = completedLifeMemoryGovernance(memory, operation);
        if (recovered) {
          memoryDeletion = recovered;
          operation = markLifeEventGovernanceStep(state, operation.id, { memoryStatus: 'completed', memoryDeletion });
          await persist();
        } else {
          operation = recordLifeEventGovernanceFailure(state, operation.id, { errorCode: error.code || 'LIFE_EVENT_MEMORY_GOVERNANCE_FAILED', errorStep: 'memory' });
          await persist().catch(() => {});
          error.governanceOperationId = operation.id;
          throw error;
        }
      }
    }

    let projections = operation.projections;
    if (operation.projectionStatus !== 'completed') {
      try {
        if (!rawEvent) rawEvent = governanceRawEvent(memory, operation, identifier);
        if (!rawEvent) throw Object.assign(new Error('Game event provenance is unavailable'), { code: 'LIFE_EVENT_PROVENANCE_UNAVAILABLE', status: 409 });
        projections = await redactLifeEvent(rawEvent, operation.action);
        operation = markLifeEventGovernanceStep(state, operation.id, { projectionStatus: 'completed', projections });
        await persist();
      } catch (error) {
        operation = recordLifeEventGovernanceFailure(state, operation.id, { errorCode: error.code || 'LIFE_EVENT_PROJECTION_FAILED', errorStep: 'projections' });
        await persist().catch(() => {});
        error.governanceOperationId = operation.id;
        throw error;
      }
    }

    const reconciliation = reconcileLifeEventGovernance({ state, memory, operation });
    if (!reconciliation.complete) {
      operation = markLifeEventGovernanceStep(state, operation.id, {
        projectionStatus: 'pending',
        errorCode: 'LIFE_EVENT_RECONCILIATION_INCOMPLETE',
        errorStep: 'reconciliation'
      });
      await persist();
      const error = Object.assign(new Error('Life event governance requires repair'), { code: 'LIFE_EVENT_RECONCILIATION_INCOMPLETE', status: 503, governanceOperationId: operation.id });
      throw error;
    }
    return { operation, reconciliation, memoryDeletion, projections };
  };

  return {
    lifeStateForResponse,
    redactLifeEvent,
    runLifeEventGovernance,
    sendLifeEventResponse
  };
}
