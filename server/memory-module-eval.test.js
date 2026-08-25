import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRealMemoryEvaluationInput } from './memory-module-eval.js';

function realEvaluationFixture({ synthetic = false, caseCount = 600, datasetKind = 'deidentified', version = 'v0.2-real-test', provenance = { datasetId: 'fixture', source: 'unit-test' } } = {}) {
  const cases = Array.from({ length: caseCount }, (_, index) => ({
    id: `real-case-${index + 1}`,
    category: 'direct_profile',
    query: `fixture query ${index + 1}`,
    expected: `fixture value ${index + 1}`,
    expectedMode: 'known',
    synthetic,
    version
  }));
  const results = Object.fromEntries(cases.map(item => [item.id, {
    answerability: 'known',
    items: [{ content: item.expected, sourceRefs: ['fixture-source'] }],
    uncertainties: []
  }]));
  return {
    casesPayload: { version, datasetKind, synthetic, provenance, cases },
    resultsPayload: { version, datasetKind, synthetic, provenance: { ...provenance, runId: 'fixture-run' }, results }
  };
}

test('v0.1 evaluation set has 50 versionable cases across required baseline categories', async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/memory-module-eval-v0.1.json');
  const cases = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(cases.length, 50);
  assert.equal(new Set(cases.map(item => item.id)).size, 50);
  for (const category of ['preference', 'relationship', 'current_state', 'no_answer', 'conflict', 'scope']) assert.ok(cases.some(item => item.category === category));
  assert.ok(cases.some(item => item.query.includes('What')));
  assert.ok(cases.some(item => item.query.includes('agent-b')));
});

test('v0.2 evaluation scaffold has 600 versioned cases with the roadmap category distribution', async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../docs/memory-module-eval-v0.2.json');
  const cases = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(cases.length, 600);
  assert.equal(new Set(cases.map(item => item.id)).size, 600);
  const expectedCounts = {
    direct_profile: 120,
    paraphrase: 90,
    temporal_episode: 120,
    relationship: 90,
    bridge: 60,
    no_answer: 60,
    conflict: 30,
    scope: 30
  };
  for (const [category, count] of Object.entries(expectedCounts)) assert.equal(cases.filter(item => item.category === category).length, count);
  assert.ok(cases.every(item => item.synthetic === true && item.version === 'v0.2' && ['development', 'holdout', 'acceptance'].includes(item.split)));
  assert.ok(cases.some(item => item.expectedMode === 'no_answer'));
  assert.ok(cases.some(item => item.expectedMode === 'conflict'));
  assert.ok(cases.some(item => item.expectedMode === 'authorization'));
});

test('real evaluation validator accepts only a complete 600-case real/deidentified envelope', () => {
  const fixture = realEvaluationFixture();
  const validated = validateRealMemoryEvaluationInput(fixture);
  assert.equal(validated.cases.length, 600);
  assert.equal(validated.results.size, 600);
  assert.equal(validated.datasetKind, 'deidentified');
  assert.equal(validated.version, 'v0.2-real-test');
});

test('real evaluation validator rejects synthetic inputs, missing provenance, partial coverage, and split subsets', () => {
  assert.throws(
    () => validateRealMemoryEvaluationInput(realEvaluationFixture({ synthetic: true })),
    /synthetic must be false/
  );
  assert.throws(
    () => validateRealMemoryEvaluationInput(realEvaluationFixture({ provenance: {} })),
    /provenance must be a non-empty metadata object/
  );
  assert.throws(
    () => validateRealMemoryEvaluationInput(realEvaluationFixture({ caseCount: 599 })),
    /exactly 600 cases/
  );
  const incomplete = realEvaluationFixture();
  delete incomplete.resultsPayload.results['real-case-600'];
  assert.throws(
    () => validateRealMemoryEvaluationInput(incomplete),
    /exactly one record for every case/
  );
  assert.throws(
    () => validateRealMemoryEvaluationInput({ ...realEvaluationFixture(), split: 'acceptance' }),
    /requires MEMORY_EVAL_SPLIT=all/
  );
});

test('real evaluation validator rejects bare synthetic scaffold and synthetic result envelope', () => {
  const fixture = realEvaluationFixture();
  fixture.casesPayload.cases[0].synthetic = true;
  assert.throws(
    () => validateRealMemoryEvaluationInput(fixture),
    /cases\[0\]\.synthetic must be false/
  );

  const syntheticResult = realEvaluationFixture();
  syntheticResult.resultsPayload.synthetic = true;
  assert.throws(
    () => validateRealMemoryEvaluationInput(syntheticResult),
    /evaluation results\.synthetic must be false/
  );
});
