import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionLifeRuntime } from './life-runtime.js';

function harness() {
  const rawEvent = {
    id: 'raw-life-1',
    eventId: 'life:event-1',
    resourceRevision: 3,
    metadata: { source_type: 'game' }
  };
  const state = {
    companion: {},
    lifeState: { currentEvent: null, recentEvents: [], commandLog: [] },
    evidence: [],
    relationshipStates: { cochpia: { signals: [] } },
    personalityProjection: { appliedSourceEventIds: [] },
    personalityHistory: [],
    personalityAudit: []
  };
  const memory = {
    state: { rawEvents: [rawEvent], tombstones: [], deletionOperations: [] },
    async deleteSourceEvent(_context, sourceEventId, input) {
      assert.equal(sourceEventId, rawEvent.id);
      assert.equal(input.resourceRevision, rawEvent.resourceRevision);
      this.state.rawEvents = [];
      this.state.tombstones.push({
        id: 'tombstone-1',
        targetType: 'source_event',
        targetId: sourceEventId,
        action: 'delete',
        createdAt: new Date().toISOString()
      });
      this.state.deletionOperations.push({
        id: 'deletion-1',
        targetType: 'source_event',
        targetId: sourceEventId,
        action: 'delete',
        requestedAt: new Date().toISOString()
      });
      return { status: 'completed', deletionOperationId: 'deletion-1' };
    }
  };
  let persistCount = 0;
  const runtime = createCompanionLifeRuntime({
    state,
    persist: async () => { persistCount += 1; },
    memoryRuntime: {
      async prepareForRequest() { return memory; },
      contextFromRequest() { return { tenantId: 'tenant-1', subjectUserId: 'user-1' }; }
    },
    relationships: {
      get() { return { score: 0.42, stage: 'warming' }; },
      async redactSourceEvent() { return { removedSignalCount: 0 }; }
    },
    personalityProjection: {
      async rebuildFromConfirmedEvidence() { return { rebuilt: true }; }
    },
    redactProvenance() { return { removedEvidenceIds: [] }; }
  });
  return { runtime, state, memory, rawEvent, getPersistCount: () => persistCount };
}

test('life runtime governs a game source event across Memory Module and projections', async () => {
  const { runtime, state, memory, rawEvent } = harness();
  const result = await runtime.runLifeEventGovernance({}, {
    action: 'delete',
    identifier: rawEvent.id,
    idempotencyKey: 'life-delete-1'
  });

  assert.equal(result.memoryDeletion.status, 'completed');
  assert.equal(result.projections.projection.removedEvidenceIds.length, 0);
  assert.equal(result.reconciliation.complete, true);
  assert.equal(result.operation.status, 'completed');
  assert.equal(state.companion.lifeEventGovernance[0].status, 'completed');
  assert.equal(memory.state.rawEvents.length, 0);
});

test('life runtime preserves the LifeState response contract and status mapping', () => {
  const { runtime } = harness();
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  runtime.sendLifeEventResponse(
    response,
    { state: { revision: 4 }, duplicate: false, event: { eventId: 'life:event-2' } },
    { status: 'pending', rawEventId: null, errorCode: 'WAITING_FOR_OUTBOX' }
  );

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, {
    state: { revision: 4, relationship: 0.42, relationshipStage: 'warming' },
    duplicate: false,
    event: {
      id: 'life:event-2',
      status: 'pending',
      rawEventId: null,
      errorCode: 'WAITING_FOR_OUTBOX'
    }
  });
});

test('life runtime fails closed when governance projections do not reconcile', async () => {
  const { runtime, state, rawEvent, getPersistCount } = harness();
  state.lifeState.commandLog.push({ eventId: rawEvent.eventId, rawEventId: rawEvent.id });
  await assert.rejects(
    () => runtime.runLifeEventGovernance({}, { action: 'delete', identifier: rawEvent.id }),
    error => error.code === 'LIFE_EVENT_RECONCILIATION_INCOMPLETE' && error.status === 503
  );
  assert.ok(getPersistCount() > 0);
  assert.equal(state.companion.lifeEventGovernance[0].status, 'failed');
});
