import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePsychologyTraits, listAtmospherePresets, resolveAtmosphere } from './psychology.js';

test('ensurePsychologyTraits backfills missing dimensions idempotently', () => {
  const personality = { version: 3, traits: [{ key: 'warmth', label: '温度感', value: 0.68 }], summary: 'x', updatedAt: 'now' };
  ensurePsychologyTraits(personality);
  assert.ok(personality.traits.some(trait => trait.key === 'security'));
  assert.equal(personality.traits.length, 8);
  ensurePsychologyTraits(personality);
  assert.equal(personality.traits.filter(trait => trait.key === 'security').length, 1);
});

test('atmosphere presets list and resolve', () => {
  const presets = listAtmospherePresets();
  assert.ok(presets.length >= 3);
  assert.ok(presets.every(preset => preset.id && preset.name && preset.description));
  assert.ok(presets.every(preset => preset.tone === undefined));
  const resolved = resolveAtmosphere('secure-harbor');
  assert.ok(resolved.tone);
  assert.equal(resolveAtmosphere('nope'), null);
  assert.equal(resolveAtmosphere(null), null);
});
