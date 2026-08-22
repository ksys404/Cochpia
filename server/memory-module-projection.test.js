import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { projectStableProfile } from './memory-module-projection.js';

const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'user', actorId: 'user-a' };

test('stable user profile projection includes only sourced active S0 user assertions', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.hold(context, { content: '喜欢红茶', sensitivity: 'S0', memoryType: 'preference' });
  const session = await memory.createSession(context, { callerAgentId: 'agent-a' });
  await memory.writeCurrentState({ ...context, sessionId: session.id }, { value: '正在发布', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  const profile = projectStableProfile({ state, tenantId: 'tenant-a', userId: 'user-a', scopeType: 'user' });
  assert.equal(profile.items.length, 1);
  assert.equal(profile.items[0].displayText, '喜欢红茶');
  assert.ok(profile.items[0].sourceRefs.length > 0);
  assert.equal(state.profileProjectionSources.length, profile.items[0].sourceRefs.length);
  assert.equal(state.profileProjectionSources[0].versionId, profile.items[0].versionId);
  assert.equal(state.profileProjectionSources[0].userId, 'user-a');
});

test('relationship projection is exact-agent scoped and supersedes the previous projection', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.hold(context, { scopeType: 'relationship', relationshipAgentId: 'agent-a', content: '共同看过日落', sensitivity: 'S0' });
  await memory.hold(context, { scopeType: 'relationship', relationshipAgentId: 'agent-b', content: '共同修过灯', sensitivity: 'S0' });
  const first = projectStableProfile({ state, tenantId: 'tenant-a', userId: 'user-a', scopeType: 'relationship', relationshipAgentId: 'agent-a' });
  const second = projectStableProfile({ state, tenantId: 'tenant-a', userId: 'user-a', scopeType: 'relationship', relationshipAgentId: 'agent-a' });
  assert.equal(first.items[0].displayText, '共同看过日落');
  assert.equal(second.items[0].displayText, '共同看过日落');
  assert.equal(state.profileProjections.filter(item => item.scopeType === 'relationship' && item.relationshipAgentId === 'agent-a' && item.status === 'active').length, 1);
  assert.equal(state.profileProjectionItems.some(item => item.displayText === '共同修过灯'), false);
});
