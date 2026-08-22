import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleState } from './memory-module.js';
import { rebuildEpisodes } from './memory-module-episodes.js';

test('episode rebuild groups temporal events and preserves raw event membership', () => {
  const state = createMemoryModuleState();
  state.sessions.push({ id: 'session-a', tenantId: 'tenant-a', userId: 'user-a', status: 'active', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  state.rawEvents.push(
    { id: 'raw-1', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', occurredAt: '2026-08-22T00:00:00.000Z', content: '讨论测试计划' },
    { id: 'raw-2', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', occurredAt: '2026-08-22T00:10:00.000Z', content: '补充验收标准' },
    { id: 'raw-3', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', occurredAt: '2026-08-22T02:00:00.000Z', content: '开始恢复演练' }
  );
  const episodes = rebuildEpisodes(state, { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a' });
  assert.equal(episodes.length, 2);
  assert.equal(state.episodeMembers.filter(member => member.episodeId === episodes[0].id).length, 2);
  assert.equal(state.rawEvents.length, 3);
  assert.equal(episodes[0].groupingRuleVersion, 'temporal-window-v1');
});

test('user episodes exclude session events and redacted source events', () => {
  const state = createMemoryModuleState();
  state.sessions.push({ id: 'session-a', tenantId: 'tenant-a', userId: 'user-a', status: 'active', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  state.rawEvents.push(
    { id: 'user-event', tenantId: 'tenant-a', userId: 'user-a', sessionId: null, occurredAt: '2026-08-22T00:00:00.000Z', content: '长期事件' },
    { id: 'session-event', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', occurredAt: '2026-08-22T00:05:00.000Z', content: '临时会话事件' },
    { id: 'forgotten-event', tenantId: 'tenant-a', userId: 'user-a', sessionId: null, occurredAt: '2026-08-22T00:10:00.000Z', content: '不应复活的事件' },
    { id: 'sensitive-event', tenantId: 'tenant-a', userId: 'user-a', sessionId: null, occurredAt: '2026-08-22T00:15:00.000Z', content: '我的诊断信息' }
  );
  state.tombstones.push({ tenantId: 'tenant-a', userId: 'user-a', targetType: 'source_event', targetId: 'forgotten-event' });

  const episodes = rebuildEpisodes(state, { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(episodes.length, 1);
  assert.equal(state.episodeMembers[0].rawEventId, 'user-event');
});

test('session episode rebuild fails closed for closed or unknown sessions', () => {
  const state = createMemoryModuleState();
  state.sessions.push({ id: 'closed-session', tenantId: 'tenant-a', userId: 'user-a', status: 'closed', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  state.rawEvents.push({ id: 'closed-event', tenantId: 'tenant-a', userId: 'user-a', sessionId: 'closed-session', occurredAt: '2026-08-22T00:00:00.000Z', content: '已关闭会话' });
  assert.deepEqual(rebuildEpisodes(state, { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'closed-session' }), []);
  assert.deepEqual(rebuildEpisodes(state, { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'missing-session' }), []);
});

test('episode rebuild ignores non-final stream events', () => {
  const state = createMemoryModuleState();
  state.rawEvents.push({ id: 'draft-event', tenantId: 'tenant-a', userId: 'user-a', sessionId: null, isStreamFinal: false, occurredAt: '2026-08-22T00:00:00.000Z', content: '草稿事件' });
  assert.deepEqual(rebuildEpisodes(state, { tenantId: 'tenant-a', userId: 'user-a' }), []);
});
