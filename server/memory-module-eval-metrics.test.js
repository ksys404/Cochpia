import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMemoryRetrieval } from './memory-module-eval.js';

test('evaluation metrics compute ranked retrieval and governance slices independently', () => {
  const cases = [
    { id: 'known-1', version: 'v-test', expected: 'red tea', expectedMode: 'known' },
    { id: 'known-2', version: 'v-test', expected: 'blue', expectedMode: 'known' },
    { id: 'none-1', version: 'v-test', expected: 'missing', expectedMode: 'no_answer' },
    { id: 'conflict-1', version: 'v-test', expected: 'tea', expectedMode: 'conflict' },
    { id: 'scope-1', version: 'v-test', expected: 'forbidden', expectedMode: 'authorization' }
  ];
  const results = {
    'known-1': { items: [{ content: 'unrelated' }, { content: 'red tea', sourceRefs: ['source-1'] }] },
    'known-2': { items: [{ content: 'blue' }] },
    'none-1': { answerability: 'not_found', items: [] },
    'conflict-1': { answerability: 'conflict', items: [], uncertainties: [{ canonicalKey: 'tea' }] },
    'scope-1': { answerability: 'not_found', items: [] }
  };
  const metrics = evaluateMemoryRetrieval(cases, results, { k: 2 });
  assert.equal(metrics.totalCases, 5);
  assert.equal(metrics.recallAtK, 1);
  assert.equal(metrics.mrr, 0.75);
  assert.equal(metrics.noAnswerAccuracy, 1);
  assert.equal(metrics.conflictAccuracy, 1);
  assert.equal(metrics.authorizationAccuracy, 1);
  assert.equal(metrics.evidenceSupportRate, 0.5);
});
