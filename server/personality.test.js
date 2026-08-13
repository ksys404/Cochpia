import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPersonalityChange, createPersonalityRollbackAudit } from './personality.js';

const personality = { version: 1, summary: 'warm', traits: [{ key: 'warmth', label: 'Warmth', value: 0.5 }], updatedAt: '2026-01-01T00:00:00.000Z' };

test('personality changes are explicit and create a new auditable version', () => {
  const result = applyPersonalityChange(personality, [], { evidenceId: 'e-1', proposedChange: { traitKey: 'warmth', delta: 0.1 }, now: '2026-01-02T00:00:00.000Z' });
  assert.equal(result.personality.version, 2);
  assert.equal(result.personality.traits[0].value, 0.6);
  assert.equal(result.history[0].sourceEvidenceId, 'e-1');
  assert.equal(result.history[0].previousVersion, 1);
});

test('invalid personality changes do not mutate state', () => {
  assert.equal(applyPersonalityChange(personality, [], { proposedChange: { traitKey: 'missing', delta: 0.1 } }), null);
  assert.equal(personality.version, 1);
});

test('rollback creates an explicit audit record', () => {
  const audit = createPersonalityRollbackAudit({ fromVersion: 4, toVersion: 2, now: '2026-01-03T00:00:00.000Z' });
  assert.equal(audit.action, 'rollback');
  assert.equal(audit.fromVersion, 4);
  assert.equal(audit.toVersion, 2);
});
