import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelationshipStateService } from './relationship-state.js';

test('relationship projection is revisioned, sourced, and idempotent', async () => {
  const state = {};
  let persists = 0;
  const service = createRelationshipStateService(state, async () => { persists += 1; }, { now: () => new Date('2026-08-24T00:00:00.000Z') });
  const first = await service.observe('cochpia', { eventId: 'evt-1', sourceEventId: 'raw-1', signalType: 'conversation.turn', delta: 2 });
  assert.equal(first.state.score, 52);
  assert.equal(first.state.resourceRevision, 2);
  assert.equal(first.signal.sourceEventId, 'raw-1');
  const replay = await service.observe('cochpia', { eventId: 'evt-1', delta: 9 });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.score, 52);
  assert.equal(persists, 1);
});

test('relationship projection rejects stale CAS writes and clamps signal deltas', async () => {
  const service = createRelationshipStateService({}, async () => {}, { now: () => new Date('2026-08-24T00:00:00.000Z') });
  await service.observe('agent-a', { eventId: 'evt-2', delta: 99 });
  assert.equal(service.get('agent-a').score, 60);
  await assert.rejects(() => service.observe('agent-a', { eventId: 'evt-3', delta: 1, expectedRevision: 1 }), error => error.code === 'RELATIONSHIP_REVISION_CONFLICT');
});

test('relationship projection removes a source-event signal without affecting other signals', async () => {
  const state = { relationshipStates: {} };
  const service = createRelationshipStateService(state);
  await service.observe('cochpia', { eventId: 'life-event-1', sourceEventId: 'raw-life-1', delta: 3, signalType: 'life.action.completed' });
  await service.observe('cochpia', { eventId: 'chat-event-1', sourceEventId: 'raw-chat-1', delta: 1, signalType: 'conversation.turn' });
  const result = await service.redactSourceEvent('cochpia', 'raw-life-1');
  assert.equal(result.removed, 1);
  assert.equal(result.state.score, 51);
  assert.deepEqual(result.state.sourceEventIds, ['raw-chat-1']);
  assert.equal(result.state.signals.some(signal => signal.sourceEventId === 'raw-life-1'), false);
});
