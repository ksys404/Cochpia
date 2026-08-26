import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidenceEnvelope, assessFullCanonical1MArtifact, gateResult, isAlphaGateReady } from './companion-alpha-gate.js';

const validArtifact = {
  runDate: '2026-08-24',
  documentCount: 1_000_000,
  assertionCount: 1_000_000,
  leanIndex: false,
  fastSeed: false,
  pgvector: true,
  hnswRebuiltAfterSeed: true,
  provenance: { dataset: 'deidentified-v1', operator: 'acceptance' },
  reproduction: 'DATABASE_URL=<isolated> npm run benchmark:memory-postgres'
};

test('Alpha Gate rejects lean or fast-seed 1M artifacts', () => {
  assert.equal(assessFullCanonical1MArtifact({ ...validArtifact, leanIndex: true }).status, 'failed');
  assert.equal(assessFullCanonical1MArtifact({ ...validArtifact, fastSeed: true }).status, 'failed');
  assert.equal(assessFullCanonical1MArtifact({ ...validArtifact, assertionCount: 10_000 }).status, 'failed');
});
test('Alpha Gate accepts only a complete canonical 1M artifact with provenance', () => {
  const result = assessFullCanonical1MArtifact(validArtifact, ['artifact.json']);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.evidence, ['artifact.json']);
  assert.equal(assessFullCanonical1MArtifact({ ...validArtifact, provenance: {} }).status, 'failed');
});

test('Alpha Gate evidence envelopes require every declared gate to be true', () => {
  const required = ['https', 'logs', 'cache'];
  assert.equal(assessEvidenceEnvelope({ gates: { https: true, logs: true, cache: true } }, required).status, 'passed');
  assert.equal(assessEvidenceEnvelope({ gates: { https: true, logs: true, cache: false } }, required).status, 'failed');
  assert.equal(assessEvidenceEnvelope(null, required).status, 'failed');
});

test('Alpha Gate readiness is fail-closed when any gate is missing', () => {
  assert.equal(isAlphaGateReady({ local: gateResult('passed', 'ok'), hosted: gateResult('passed', 'ok') }), true);
  assert.equal(isAlphaGateReady({ local: gateResult('passed', 'ok'), hosted: gateResult('missing', 'not supplied') }), false);
  assert.equal(isAlphaGateReady({}), false);
});
