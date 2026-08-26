import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrowthEvidenceService } from './growth-evidence.js';

test('growth evidence is independent from the memory backend', async () => {
  const state = { evidence: [] };
  let persists = 0;
  const evidence = createGrowthEvidenceService(state, async () => { persists += 1; });
  const created = await evidence.grow({ claim: '温度感需要微调', evidence: '用户连续表达了希望更直接的回应', proposedChange: { traitKey: 'warmth', delta: -0.005 } });

  assert.equal(evidence.trace(created.id).status, 'draft');
  const confirmed = await evidence.updateEvidence(created.id, 'confirmed');
  assert.equal(confirmed.userConfirmation, true);
  assert.equal(persists, 2);
});

test('growth evidence rejects unknown review states', async () => {
  const evidence = createGrowthEvidenceService({ evidence: [] });
  const created = await evidence.grow({ claim: 'test', evidence: 'test' });
  assert.throws(() => evidence.updateEvidence(created.id, 'unknown'), /Invalid evidence status/);
});

test('growth evidence rolls back an in-memory review when persistence fails', async () => {
  const state = { evidence: [] };
  let fail = false;
  const service = createGrowthEvidenceService(state, async () => { if (fail) throw new Error('persistence failed'); });
  const item = await service.grow({ claim: 'reviewable' });
  fail = true;
  await assert.rejects(() => service.updateEvidence(item.id, 'confirmed'), /persistence failed/);
  assert.equal(service.trace(item.id).status, 'draft');
});

test('source-event growth evidence is idempotent and preserves provenance for later personality review', async () => {
  const state = { evidence: [] };
  let persists = 0;
  const service = createGrowthEvidenceService(state, async () => { persists += 1; });
  const first = await service.growFromSourceEvent('raw-life-1', {
    claim: '共同经历形成成长证据',
    evidence: '一起在咖啡馆停留',
    proposedChange: { traitKey: 'warmth', delta: 0.002 }
  });
  const replay = await service.growFromSourceEvent('raw-life-1', { evidence: '重复提交' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);
  assert.equal(service.trace(first.id).sourceEventId, 'raw-life-1');
  assert.equal(service.trace(first.id).status, 'draft');
  assert.equal(persists, 1);
});
