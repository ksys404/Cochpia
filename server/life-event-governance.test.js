import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginLifeEventGovernance,
  ensureLifeEventGovernanceState,
  markLifeEventGovernanceStep,
  reconcileLifeEventGovernance
} from './life-event-governance.js';

const now = new Date('2026-08-24T00:00:00.000Z');

test('life event governance keeps a recoverable operation after memory succeeds before projections', () => {
  const state = {
    companion: {},
    lifeState: {
      currentEvent: { id: 'life:event-1' },
      recentEvents: [{ id: 'life:event-1' }],
      commandLog: [{ eventId: 'life:event-1', rawEventId: 'raw-life-1' }]
    },
    evidence: [{ id: 'e-1', sourceEventId: 'raw-life-1' }],
    relationshipStates: { cochpia: { signals: [{ eventId: 'life:event-1', sourceEventId: 'raw-life-1' }] } },
    personalityProjection: { appliedSourceEventIds: ['raw-life-1'] },
    personalityAudit: [{ sourceEventId: 'raw-life-1' }]
  };
  const memory = { rawEvents: [], tombstones: [{ id: 't-1', targetType: 'source_event', targetId: 'raw-life-1', action: 'delete', createdAt: now.toISOString() }] };
  const started = beginLifeEventGovernance(state, {
    action: 'delete',
    rawEvent: { id: 'raw-life-1', eventId: 'life:event-1' },
    idempotencyKey: 'delete-life-1',
    now
  });
  markLifeEventGovernanceStep(state, started.operation.id, {
    memoryStatus: 'completed',
    memoryDeletion: { status: 'completed' },
    now
  });
  const report = reconcileLifeEventGovernance({ state, memory, operation: state.companion.lifeEventGovernance[0], now });
  assert.equal(report.memory.ok, true);
  assert.equal(report.projections.ok, false);
  assert.equal(report.projections.personalityAuditReferences, 1);
  assert.equal(report.complete, false);
  assert.equal(state.companion.lifeEventGovernance[0].status, 'projection_pending');
  assert.equal(state.companion.lifeEventGovernance[0].rawEventId, 'raw-life-1');
});

test('life event governance reaches completed only after memory and all projections reconcile', () => {
  const state = {
    companion: {},
    lifeState: { currentEvent: null, recentEvents: [], commandLog: [] },
    evidence: [],
    relationshipStates: { cochpia: { signals: [] } },
    personalityProjection: { appliedSourceEventIds: [] },
    personalityAudit: []
  };
  ensureLifeEventGovernanceState(state);
  const started = beginLifeEventGovernance(state, {
    action: 'forget',
    rawEvent: { id: 'raw-life-2', eventId: 'life:event-2' },
    now
  });
  const completed = markLifeEventGovernanceStep(state, started.operation.id, {
    memoryStatus: 'completed',
    memoryDeletion: { status: 'forgotten' },
    now
  });
  assert.equal(completed.status, 'projection_pending');
  markLifeEventGovernanceStep(state, started.operation.id, {
    projectionStatus: 'completed',
    projections: { removedCommandCount: 1 },
    now
  });
  const operation = state.companion.lifeEventGovernance[0];
  const report = reconcileLifeEventGovernance({
    state,
    memory: { rawEvents: [{ id: 'raw-life-2' }], tombstones: [{ id: 't-2', targetType: 'source_event', targetId: 'raw-life-2', action: 'forget' }] },
    operation,
    now
  });
  assert.equal(report.complete, true);
  assert.equal(operation.status, 'completed');
});

test('personality audit provenance is reported separately and does not count as a live projection leak', () => {
  const state = {
    companion: {},
    lifeState: { currentEvent: null, recentEvents: [], commandLog: [] },
    evidence: [],
    relationshipStates: { cochpia: { signals: [] } },
    personalityProjection: { appliedSourceEventIds: [] },
    personalityHistory: [],
    personalityAudit: [{ sourceEventId: 'raw-life-3', action: 'rebuild_after_redaction' }]
  };
  const started = beginLifeEventGovernance(state, {
    action: 'forget',
    rawEvent: { id: 'raw-life-3', eventId: 'life:event-3' },
    now
  });
  markLifeEventGovernanceStep(state, started.operation.id, { memoryStatus: 'completed', now });
  markLifeEventGovernanceStep(state, started.operation.id, { projectionStatus: 'completed', now });
  const report = reconcileLifeEventGovernance({
    state,
    memory: { rawEvents: [{ id: 'raw-life-3' }], tombstones: [{ targetType: 'source_event', targetId: 'raw-life-3', action: 'forget' }] },
    operation: state.companion.lifeEventGovernance[0],
    now
  });
  assert.equal(report.complete, true);
  assert.equal(report.projections.personalityLeaks, 0);
  assert.equal(report.projections.personalityAuditReferences, 1);
});
