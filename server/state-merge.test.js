import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState } from './state-merge.js';

test('mergeState adds missing items by id without overwriting existing ones', () => {
  const base = {
    sessions: [{ id: 'a', title: 'existing' }],
    messages: { a: [{ id: 'm1', role: 'user', content: 'old' }] },
    memories: [{ id: 'm1' }],
    personality: { version: 2 },
    evidence: [], personalityHistory: [], personalityAudit: []
  };
  const incoming = {
    sessions: [{ id: 'a', title: 'imported-dup' }, { id: 'b', title: 'new' }],
    messages: { a: [{ id: 'm1', content: 'dup' }, { id: 'm2', content: 'new' }], b: [{ id: 'm3', content: 'b-msg' }] },
    memories: [{ id: 'm1' }, { id: 'm2' }],
    personality: { version: 99 },
    evidence: [], personalityHistory: [], personalityAudit: []
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

test('mergeState imports workspace preferences only when missing', () => {
  const imported = mergeState({ sessions: [], workspacePreferences: null }, { workspacePreferences: { theme: { themeId: 'ink' } } });
  assert.equal(imported.workspacePreferences.theme.themeId, 'ink');
  const existing = mergeState({ sessions: [], workspacePreferences: { theme: { themeId: 'sakura' } } }, { workspacePreferences: { theme: { themeId: 'ink' } } });
  assert.equal(existing.workspacePreferences.theme.themeId, 'sakura');
});

test('mergeState preserves and merges Memory Module state', () => {
  const base = {
    sessions: [],
    memoryModule: {
      assertions: [{ id: 'a1', content: 'existing' }],
      sequence: 3,
      redactionEpochs: { 'tenant:user': 1 },
      policyVersion: 'memory-policy-v1'
    }
  };
  const incoming = {
    memoryModule: {
      assertions: [{ id: 'a1', content: 'should-not-overwrite' }, { id: 'a2', content: 'new' }],
      sequence: 8,
      redactionEpochs: { 'tenant:user': 0, 'tenant:other': 2 },
      policyVersion: 'memory-policy-v2'
    }
  };
  const merged = mergeState(base, incoming);
  assert.deepEqual(merged.memoryModule.assertions, [{ id: 'a1', content: 'existing' }, { id: 'a2', content: 'new' }]);
  assert.equal(merged.memoryModule.sequence, 8);
  assert.deepEqual(merged.memoryModule.redactionEpochs, { 'tenant:user': 1, 'tenant:other': 2 });
  assert.equal(merged.memoryModule.policyVersion, 'memory-policy-v1');
});

test('mergeState preserves pending interaction outbox entries without overwriting canonical entries', () => {
  const merged = mergeState({
    sessions: [],
    companion: {
      dataRevision: 3,
      interactionOutbox: [{ id: 'outbox-1', status: 'completed' }]
    }
  }, {
    companion: {
      dataRevision: 8,
      interactionOutbox: [{ id: 'outbox-1', status: 'pending' }, { id: 'outbox-2', status: 'pending' }]
    }
  });
  assert.deepEqual(merged.companion.interactionOutbox, [
    { id: 'outbox-1', status: 'completed' },
    { id: 'outbox-2', status: 'pending' }
  ]);
  assert.equal(merged.companion.dataRevision, 8);
});

test('mergeState rejects invalid payloads', () => {
  assert.throws(() => mergeState({}, null), /Invalid import state/);
  assert.throws(() => mergeState(null, {}), /Invalid base state/);
});
