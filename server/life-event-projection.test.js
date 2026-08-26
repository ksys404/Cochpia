import test from 'node:test';
import assert from 'node:assert/strict';
import { redactLifeEventProvenance } from './life-event-projection.js';

test('redacting a game source event removes its life state, command, and growth evidence projections', () => {
  const state = {
    lifeState: {
      currentEvent: { id: 'life:event-1', text: 'private event' },
      recentEvents: [{ id: 'life:event-1', text: 'private event' }, { id: 'life:event-2', text: 'keep' }],
      commandLog: [{ eventId: 'life:event-1', rawEventId: 'raw-life-1' }, { eventId: 'life:event-2', rawEventId: 'raw-life-2' }],
      lastAction: 'cafe',
      lastChanges: [{ key: 'mood', value: 1 }],
      pendingDecision: { title: 'decision' }
    },
    evidence: [
      { id: 'e-life-1', type: 'life_event', sourceEventId: 'raw-life-1', evidence: 'private event' },
      { id: 'e-keep', type: 'life_event', sourceEventId: 'raw-life-2', evidence: 'keep' }
    ]
  };
  const result = redactLifeEventProvenance(state, { rawEventId: 'raw-life-1', now: new Date('2026-08-24T00:00:00.000Z') });
  assert.equal(result.currentEventRedacted, true);
  assert.equal(result.removedCommandCount, 1);
  assert.equal(result.removedEventCount, 1);
  assert.deepEqual(result.removedEvidenceIds, ['e-life-1']);
  assert.equal(state.lifeState.currentEvent, null);
  assert.equal(state.lifeState.pendingDecision, null);
  assert.deepEqual(state.lifeState.recentEvents, [{ id: 'life:event-2', text: 'keep' }]);
  assert.deepEqual(state.evidence.map(item => item.id), ['e-keep']);
});
