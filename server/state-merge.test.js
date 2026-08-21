import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState } from './state-merge.js';

test('mergeState adds missing items by id without overwriting existing ones', () => {
  const base = {
    sessions: [{ id: 'a', title: 'existing' }],
    messages: { a: [{ id: 'm1', role: 'user', content: 'old' }] },
    memories: [{ id: 'm1' }],
    personality: { version: 2 },
    evidence: [], tasks: [], personalityHistory: [], personalityAudit: []
  };
  const incoming = {
    sessions: [{ id: 'a', title: 'imported-dup' }, { id: 'b', title: 'new' }],
    messages: { a: [{ id: 'm1', content: 'dup' }, { id: 'm2', content: 'new' }], b: [{ id: 'm3', content: 'b-msg' }] },
    memories: [{ id: 'm1' }, { id: 'm2' }],
    personality: { version: 99 },
    evidence: [], tasks: [], personalityHistory: [], personalityAudit: []
  };
  const merged = mergeState(base, incoming);
  assert.equal(merged.sessions.length, 2);
  assert.equal(merged.sessions[0].title, 'existing');
  assert.equal(merged.messages.a.length, 2);
  assert.equal(merged.messages.b.length, 1);
  assert.equal(merged.memories.length, 2);
  assert.equal(merged.personality.version, 2);
});

test('mergeState fills personality only when missing', () => {
  const merged = mergeState({ sessions: [] }, { personality: { version: 7 }, sessions: [] });
  assert.equal(merged.personality.version, 7);
});

test('mergeState rejects invalid payloads', () => {
  assert.throws(() => mergeState({}, null), /Invalid import state/);
  assert.throws(() => mergeState(null, {}), /Invalid base state/);
});
