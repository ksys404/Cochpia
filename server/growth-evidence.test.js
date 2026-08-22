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
