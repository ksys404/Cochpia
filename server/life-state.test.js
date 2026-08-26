import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifeStateService, DEFAULT_LIFE_STATE } from './life-state.js';

function harness() {
  const state = { lifeState: structuredClone(DEFAULT_LIFE_STATE) };
  let persists = 0;
  const service = createLifeStateService(state, async () => { persists += 1; }, { now: () => new Date('2026-08-24T00:00:00.000Z') });
  return { state, service, get persists() { return persists; } };
}

test('life state action is server-owned, revisioned, and idempotent', async () => {
  const h = harness();
  const first = await h.service.advance('cafe', { idempotencyKey: 'life-command-1', expectedRevision: 1, sessionId: 'session-life-1' });
  assert.equal(first.state.resourceRevision, 2);
  assert.equal(first.event.eventType, 'life.action.completed');
  assert.equal(first.event.eventStatus, 'pending');
  assert.equal(first.event.sessionId, 'session-life-1');
  assert.ok(first.event.content.length > 0);
  const replay = await h.service.advance('cafe', { idempotencyKey: 'life-command-1', expectedRevision: 1 });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.resourceRevision, 2);
  assert.equal(h.persists, 1);
});

test('life state rejects stale writes and invalid decisions', async () => {
  const h = harness();
  await h.service.advance('work', { idempotencyKey: 'life-command-2' });
  await assert.rejects(() => h.service.advance('home', { idempotencyKey: 'life-command-3', expectedRevision: 1 }), error => error.code === 'LIFE_STATE_REVISION_CONFLICT');
  await assert.rejects(() => h.service.resolveDecision('reply', { idempotencyKey: 'life-command-4' }), error => error.code === 'LIFE_DECISION_NOT_PENDING');
});

test('decision and reset transitions keep replayable provenance', async () => {
  const h = harness();
  await h.service.advance('walk', { idempotencyKey: 'life-command-5' });
  await h.service.advance('walk', { idempotencyKey: 'life-command-6' });
  const decision = await h.service.resolveDecision('reply', { idempotencyKey: 'life-command-7' });
  assert.equal(decision.event.eventType, 'life.decision.resolved');
  const reset = await h.service.reset({ idempotencyKey: 'life-command-8', expectedRevision: decision.state.resourceRevision });
  assert.equal(reset.event.eventType, 'life.state.reset');
  assert.equal(reset.state.commandLog.length, 4);
  await h.service.markEventStatus('life-command-8', { status: 'accepted_stored', rawEventId: 'raw-life-8' });
  assert.equal(h.service.findCommand('life-command-8').rawEventId, 'raw-life-8');
});

test('life mode changes use the same revisioned command path', async () => {
  const h = harness();
  const result = await h.service.setMode('observe', { idempotencyKey: 'life-mode-1', expectedRevision: 1 });
  assert.equal(result.state.mode, 'observe');
  assert.equal(result.event.eventType, 'life.mode.changed');
  assert.equal(result.event.structuredData.mode, 'observe');
});
