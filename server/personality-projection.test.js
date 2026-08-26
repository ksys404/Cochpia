import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalityProjection } from './personality-projection.js';

function service() {
  const state = { personality: { version: 1, traits: [{ key: 'warmth', label: '温度感', value: 0.5 }], summary: 'warm' } };
  let persists = 0;
  return { state, projection: createPersonalityProjection(state, async () => { persists += 1; }, { now: () => new Date('2026-08-24T00:00:00.000Z') }), get persists() { return persists; } };
}

test('personality projection versions confirmed evidence and keeps source provenance', async () => {
  const h = service();
  const result = await h.projection.applyConfirmedEvidence({ id: 'e-1', sourceEventId: 'raw-1', proposedChange: { traitKey: 'warmth', delta: 0.1 } });
  assert.equal(result.personality.version, 2);
  assert.equal(result.personality.resourceRevision, 2);
  assert.equal(result.history[0].sourceEventId, 'raw-1');
  assert.equal(result.history[0].sourceAssertionVersionId, null);
  assert.equal(result.audit.sourceEventId, 'raw-1');
  const replay = await h.projection.applyConfirmedEvidence({ id: 'e-1', sourceEventId: 'raw-1', proposedChange: { traitKey: 'warmth', delta: 0.2 } });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.personality.version, 2);
  assert.equal(h.persists, 1);
});

test('personality rollback uses CAS and creates an auditable revision', async () => {
  const h = service();
  await h.projection.applyConfirmedEvidence({ id: 'e-2', proposedChange: { traitKey: 'warmth', delta: 0.1 } });
  await assert.rejects(() => h.projection.rollback(1, { expectedRevision: 1 }), error => error.code === 'PERSONALITY_REVISION_CONFLICT');
  const result = await h.projection.rollback(1, { expectedRevision: 2 });
  assert.equal(result.personality.version, 1);
  assert.equal(result.audit.action, 'rollback');
  assert.equal(result.personality.resourceRevision, 3);
});

test('personality projection rebuild removes confirmed evidence tied to a redacted source event', async () => {
  const h = service();
  h.state.evidence = [
    { id: 'e-life', status: 'confirmed', sourceEventId: 'raw-life-1', proposedChange: { traitKey: 'warmth', delta: 0.1 }, createdAt: '2026-08-24T00:00:00.000Z' },
    { id: 'e-chat', status: 'confirmed', sourceEventId: 'raw-chat-1', proposedChange: { traitKey: 'warmth', delta: 0.05 }, createdAt: '2026-08-24T00:00:01.000Z' }
  ];
  const first = await h.projection.applyConfirmedEvidence({ id: 'e-life', sourceEventId: 'raw-life-1', proposedChange: { traitKey: 'warmth', delta: 0.1 } });
  await h.projection.applyConfirmedEvidence({ id: 'e-chat', sourceEventId: 'raw-chat-1', proposedChange: { traitKey: 'warmth', delta: 0.05 } });
  assert.equal(first.personality.traits[0].value, 0.6);
  const result = await h.projection.rebuildFromConfirmedEvidence({ excludedSourceEventIds: ['raw-life-1'] });
  assert.equal(result.personality.traits[0].value, 0.55);
  assert.deepEqual(h.state.personalityProjection.appliedSourceEventIds, ['raw-chat-1']);
  assert.equal(result.audit.action, 'rebuild_after_redaction');
});
