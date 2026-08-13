import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryService, decayedStrength } from './memory-service.js';

test('memory records preserve category, source event, and metadata', async () => {
  const state = { memories: [], evidence: [] };
  const service = createMemoryService(state, async () => {});
  const memory = await service.hold({ type: 'relationship', category: 'relationship', summary: 'A shared event', sourceEvent: 'message-1', metadata: { importance: 0.8 } });
  assert.equal(memory.category, 'relationship');
  assert.equal(memory.sourceEvent, 'message-1');
  assert.equal(memory.metadata.importance, 0.8);
});

test('growth evidence requires confirmation before it becomes confirmed', async () => {
  const state = { memories: [], evidence: [] };
  const service = createMemoryService(state, async () => {});
  const evidence = await service.grow({ claim: 'A change may be useful', evidence: 'Observed in a message', proposedChange: { traitKey: 'warmth', delta: 0.005 } });
  assert.equal(evidence.status, 'draft');
  assert.equal(evidence.userConfirmation, null);
  const confirmed = await service.updateEvidence(evidence.id, 'confirmed');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.userConfirmation, true);
});

test('hold stores valence, arousal, and importance with clamping', async () => {
  const state = { memories: [], evidence: [] };
  const service = createMemoryService(state, async () => {});
  const memory = await service.hold({ summary: 'emotional record', valence: 5, arousal: -1, importance: 2 });
  assert.equal(memory.valence, 1);
  assert.equal(memory.arousal, 0);
  assert.equal(memory.importance, 1);
  assert.equal(memory.strength, 0.72);
});

test('decayed strength decreases over time and decays slower for important memories', () => {
  const now = new Date();
  const base = { strength: 0.8, updatedAt: new Date(now.getTime() - 10 * 86400000).toISOString() };
  const important = decayedStrength({ ...base, importance: 0.95 }, now);
  const trivial = decayedStrength({ ...base, importance: 0.1 }, now);
  const fresh = decayedStrength({ ...base, importance: 0.95, updatedAt: now.toISOString() }, now);
  assert.ok(important > trivial, 'important memory should decay slower');
  assert.ok(fresh > important, 'fresh memory should be stronger');
  assert.ok(important > 0 && important < 0.8, 'decay should reduce but not eliminate strength');
});

test('breath ranks by relevance and decayed strength', () => {
  const now = new Date();
  const state = { memories: [
    { id: 'a', summary: 'about the ocean', strength: 0.9, importance: 0.9, valence: 0.5, arousal: 0.4, updatedAt: now.toISOString() },
    { id: 'b', summary: 'about the ocean', strength: 0.9, importance: 0.1, valence: 0.5, arousal: 0.4, updatedAt: new Date(now.getTime() - 30 * 86400000).toISOString() },
    { id: 'c', summary: 'unrelated topic', strength: 0.9, importance: 0.9, valence: 0.5, arousal: 0.4, updatedAt: now.toISOString() }
  ], evidence: [] };
  const service = createMemoryService(state, async () => {});
  const results = service.breath('ocean');
  assert.equal(results[0].id, 'a');
  assert.equal(results[1].id, 'b');
  assert.equal(results[2].id, 'c');
});
