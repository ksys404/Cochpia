import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUserState } from './store.js';
import { createMemoryModuleState } from './memory-module.js';

// 模拟单用户时代遗留的 base state:里面装的是**上一位用户**的全部内容。
const legacyBaseState = () => ({
  messages: { 'session-legacy': [{ id: 'm1' }] },
  sessions: [{ id: 'session-legacy', ownerId: 'local-user' }],
  mode: 'work',
  profile: {
    name: 'LegacyPersona',
    gender: 'male',
    age: 26,
    avatar: '✦',
    avatarImage: 'data:image/jpeg;base64,LEGACY_AVATAR',
    characterSheet: 'data:image/png;base64,LEGACY_SHEET'
  },
  agents: [{ id: 'agent-legacy', name: 'LegacyPersona', ownerId: 'local-user' }],
  agentTasks: [{ id: 'task-legacy' }],
  evidence: [{ id: 'evidence-legacy' }],
  events: [{ id: 'event-legacy' }],
  memories: [{ id: 'legacy-memory' }],
  personality: { warmth: 0.92 },
  personalityHistory: [{ version: 1 }],
  personalityAudit: [{ action: 'seed' }],
  innerStates: { 'agent-legacy': { items: [{ id: 'inner-legacy' }] } },
  wakeStates: { 'agent-legacy': { theta: 0.5 } },
  wakePreferences: { enabled: true },
  relationshipStates: { 'agent-legacy': { stage: 'close' } },
  companion: { sessionMappings: { 'session-legacy': 'memory-session-legacy' } },
  tasks: [{ id: 'legacy-task' }],
  uploads: [{ id: 'legacy-upload' }],
  workspacePreferences: { theme: 'dark' },
  workspacePreferencesUpdatedAt: '2026-01-01T00:00:00.000Z',
  collaborationRuns: [{ id: 'legacy-run' }],
  memoryModule: {
    ...createMemoryModuleState(),
    sequence: 42,
    assertions: [{ id: 'mem-legacy', userId: 'local-user', importance: 0.6 }],
    rawEvents: [{ id: 'evt-legacy', userId: 'local-user', content: '别人说过的话' }],
    auditEvents: [{ id: 'audit-legacy', userId: 'local-user' }]
  }
});

test('a new user inherits nothing from the legacy single-user state', () => {
  const next = emptyUserState(legacyBaseState());
  const serialized = JSON.stringify(next);

  const forbidden = [
    'LegacyPersona', 'LEGACY_AVATAR', 'LEGACY_SHEET', 'data:image',
    'session-legacy', 'agent-legacy', 'task-legacy', 'evidence-legacy', 'event-legacy',
    'legacy-memory', 'legacy-task', 'legacy-upload', 'legacy-run',
    'mem-legacy', 'evt-legacy', 'audit-legacy', 'inner-legacy',
    '别人说过的话', 'warmth', 'theta', 'sessionMappings', 'dark', 'local-user'
  ];
  for (const marker of forbidden) {
    assert.equal(serialized.includes(marker), false, `新用户状态里不应出现 ${marker}`);
  }

  // fail-closed:键集合与取值都必须精确等于规范空值,多出来的键本身就是泄漏。
  assert.deepEqual(next, {
    mode: 'companion',
    profile: { name: '', gender: 'none', age: null, avatar: '✦' },
    sessions: [],
    messages: {},
    memories: [],
    evidence: [],
    agents: [],
    agentTasks: [],
    proposals: [],
    events: [],
    collaborationRuns: [],
    memoryModule: createMemoryModuleState()
  });
});

test('collections that code mutates without a guard keep the right shape', () => {
  const next = emptyUserState(legacyBaseState());
  // routes/workflows.js 直接 state.collaborationRuns.push(run),没有守卫
  for (const key of ['sessions', 'memories', 'evidence', 'agents', 'agentTasks', 'proposals', 'events', 'collaborationRuns']) {
    assert.equal(Array.isArray(next[key]), true, `${key} 必须是数组`);
  }
  assert.equal(typeof next.messages, 'object');
  assert.equal(Array.isArray(next.messages), false);
  assert.equal(Array.isArray(next.memoryModule.assertions), true);
  assert.equal(next.memoryModule.assertions.length, 0);
  assert.equal(next.memoryModule.rawEvents.length, 0);
  // 全新模块不应该带着别人的序号
  assert.equal(next.memoryModule.sequence, 0);
});

test('空 base state 与缺失 base state 都不抛错', () => {
  assert.deepEqual(emptyUserState(undefined).sessions, []);
  assert.deepEqual(emptyUserState(null).agents, []);
  assert.deepEqual(emptyUserState({}).profile, { name: '', gender: 'none', age: null, avatar: '✦' });
});

test('构造新用户状态不会改动 base state', () => {
  const base = legacyBaseState();
  const snapshot = structuredClone(base);
  emptyUserState(base);
  assert.deepEqual(base, snapshot);
});

test('两个新用户拿到的是彼此独立的空状态', () => {
  const first = emptyUserState(legacyBaseState());
  const second = emptyUserState(legacyBaseState());
  assert.deepEqual(first, second);
  first.profile.name = '改一个';
  first.sessions.push({ id: 's1' });
  first.memoryModule.assertions.push({ id: 'a1' });
  assert.equal(second.profile.name, '');
  assert.equal(second.sessions.length, 0);
  assert.equal(second.memoryModule.assertions.length, 0);
});
