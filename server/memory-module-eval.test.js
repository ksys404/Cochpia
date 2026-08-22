import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
