import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { rebuildEpisodes } from './memory-module-episodes.js';

const userContext = (userId = 'user-a', extra = {}) => ({ tenantId: 'tenant-a', subjectUserId: userId, actorType: 'user', actorId: userId, ...extra });
const agentContext = (agentId, userId = 'user-a', extra = {}) => ({ tenantId: 'tenant-a', subjectUserId: userId, actorType: 'agent', actorId: agentId, callerAgentId: agentId, ...extra });

function createHarness() {
  const state = createMemoryModuleState();
  const persisted = [];
  const memory = createMemoryModule(state, async () => { persisted.push(state.sequence); });
  return { memory, state, persisted };
}

test('event ingress rejects S3 content before canonical, outbox, or model work', async () => {
  const { memory, state } = createHarness();
  const result = await memory.recordEvent(userContext(), { eventId: 'evt-s3', content: 'my key is sk-test_12345678901234567890' });
  assert.equal(result.result, 'accepted_no_store');
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.outboxEvents.length, 0);
  assert.equal(state.auditEvents[0].action, 'event_accepted_no_store');
  await assert.rejects(() => memory.recordEvent(userContext(), { eventId: 'evt-metadata', content: 'safe', metadata: { raw_prompt: 'not allowed' } }), error => error.code === 'INVALID_METADATA');
  const duplicate = await memory.recordEvent(userContext(), { eventId: 'evt-s3', content: 'a different secret sk-another_12345678901234567890' });
  assert.equal(duplicate.result, 'duplicate');
});

test('event ingress rejects unknown storage directives instead of defaulting to persistence', async () => {
  const { memory, state } = createHarness();
  await assert.rejects(
    () => memory.recordEvent(userContext(), { eventId: 'evt-invalid-storage-directive', content: 'safe content', storage_directive: 'store_later' }),
    error => error.code === 'INVALID_STORAGE_DIRECTIVE'
  );
  assert.equal(state.rawEvents.length, 0);
});

test('do_not_store is enforced across explicit memory, correction, and current-state writes', async () => {
  const { memory, state } = createHarness();
  const noStore = await memory.hold(userContext(), { content: 'AKIA1234567890ABCDEF', storage_directive: 'do_not_store', idempotency_key: 'no-store-memory' });
  assert.equal(noStore.status, 'accepted_no_store');
  assert.equal(state.assertions.length, 0);
  assert.equal(state.assertionVersions.length, 0);
  assert.equal(state.idempotencyRecords.some(record => record.key === 'no-store-memory'), false);
  assert.equal(state.auditEvents[0].details.content, undefined);

  const created = await memory.hold(userContext(), { content: '可修改内容', sensitivity: 'S0' });
  const corrected = await memory.correct(userContext(), created.memory.memoryId, { content: '-----BEGIN PRIVATE KEY-----', resource_revision: created.memory.resourceRevision, storage_directive: 'do_not_store' });
  assert.equal(corrected.status, 'accepted_no_store');
  assert.equal(memory.get(userContext(), created.memory.memoryId).content, '可修改内容');

  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const current = await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '不应落库', expires_at: new Date(Date.now() + 60_000).toISOString(), storage_directive: 'do_not_store' });
  assert.equal(current.status, 'accepted_no_store');
  assert.equal(state.currentStates.length, 0);
});

test('S3 content in structured memory fields is rejected before canonical persistence', async () => {
  const { memory, state } = createHarness();
  await assert.rejects(
    () => memory.hold(userContext(), { content: '普通说明', structured_data: { credential: '-----BEGIN PRIVATE KEY-----' }, sensitivity: 'S0' }),
    error => error.code === 'S3_CONTENT_REJECTED' && error.status === 422
  );
  assert.equal(state.assertions.length, 0);
  assert.equal(state.assertionVersions.length, 0);
});

test('stored event idempotency rejects the same key with a different payload', async () => {
  const { memory } = createHarness();
  await memory.recordEvent(userContext(), { eventId: 'evt-stored', content: 'first payload' });
  await assert.rejects(() => memory.recordEvent(userContext(), { eventId: 'evt-stored', content: 'different payload' }), error => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409);
});

test('mutation idempotency replays the same response without creating a second memory', async () => {
  const { memory, state } = createHarness();
  const first = await memory.hold(userContext(), { content: '幂等偏好', sensitivity: 'S0', idempotency_key: 'memory-create-1' });
  const replay = await memory.hold(userContext(), { content: '幂等偏好', sensitivity: 'S0', idempotency_key: 'memory-create-1' });
  assert.equal(state.assertions.length, 1);
  assert.equal(replay.memory.memoryId, first.memory.memoryId);
  assert.deepEqual(replay, first);
  assert.equal(state.idempotencyRecords.filter(record => record.mutationNamespace === 'memory.create').length, 1);
});

test('concurrent same-key mutations serialize per subject', async () => {
  const { memory, state } = createHarness();
  const results = await Promise.all([
    memory.hold(userContext(), { content: '并发幂等', sensitivity: 'S0', idempotency_key: 'concurrent-key' }),
    memory.hold(userContext(), { content: '并发幂等', sensitivity: 'S0', idempotency_key: 'concurrent-key' })
  ]);
  assert.equal(state.assertions.length, 1);
  assert.equal(results[0].memory.memoryId, results[1].memory.memoryId);
});

test('mutation audits retain the request ID without retaining request content', async () => {
  const { memory, state } = createHarness();
  await memory.hold({ ...userContext(), requestId: 'req-memory-123' }, { content: '审计请求 ID', sensitivity: 'S0', idempotency_key: 'audit-key' });
  assert.equal(state.auditEvents[0].requestId, 'req-memory-123');
  assert.equal(state.auditEvents[0].details.requestId, 'req-memory-123');
  assert.equal(state.auditEvents[0].details.content, undefined);
});

test('mutation idempotency rejects a different payload and remains tenant/user scoped', async () => {
  const { memory, state } = createHarness();
  await memory.hold(userContext(), { content: '第一份', sensitivity: 'S0', idempotency_key: 'shared-key' });
  await assert.rejects(() => memory.hold(userContext(), { content: '第二份', sensitivity: 'S0', idempotency_key: 'shared-key' }), error => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409);
  await memory.hold(userContext('user-b'), { content: '另一用户', sensitivity: 'S0', idempotency_key: 'shared-key' });
  assert.equal(state.assertions.length, 2);
});

test('forget and delete invalidate content-bearing mutation replays', async () => {
  const { memory, state } = createHarness();
  const forgotten = await memory.hold(userContext(), { content: '会被忘记的内容', sensitivity: 'S0', idempotency_key: 'forget-create' });
  await memory.forget(userContext(), forgotten.memory.memoryId, { resourceRevision: forgotten.memory.resourceRevision, idempotency_key: 'forget-action' });
  assert.equal(state.idempotencyRecords.some(record => record.key === 'forget-create'), false);

  const deleted = await memory.hold(userContext(), { content: '会被删除的内容', sensitivity: 'S0', idempotency_key: 'delete-create' });
  await memory.remove(userContext(), deleted.memory.memoryId, { resourceRevision: deleted.memory.resourceRevision, idempotency_key: 'delete-action' });
  assert.equal(state.idempotencyRecords.some(record => record.key === 'delete-create'), false);
  assert.equal(state.idempotencyRecords.find(record => record.key === 'forget-action').response.content, undefined);
});

test('older numeric source revisions do not overwrite a newer event', async () => {
  const { memory, state } = createHarness();
  const latest = await memory.recordEvent(userContext(), { eventId: 'evt-revision-order', sourceRevision: '2', content: '最新版本' });
  const stale = await memory.recordEvent(userContext(), { eventId: 'evt-revision-order', sourceRevision: '1', content: '旧版本' });
  assert.equal(latest.result, 'accepted_stored');
  assert.equal(stale.result, 'duplicate');
  assert.equal(stale.reason, 'superseded_revision');
  assert.equal(state.rawEvents.length, 1);
  assert.equal(state.rawEvents[0].content, '最新版本');
});

test('non-final stream events are stored without entering extraction outbox', async () => {
  const { memory, state } = createHarness();
  const result = await memory.recordEvent(userContext(), { eventId: 'evt-stream-draft', content: '草稿消息', is_stream_final: false });
  assert.equal(result.result, 'accepted_stored');
  assert.equal(state.rawEvents[0].isStreamFinal, false);
  assert.equal(state.outboxEvents.length, 0);
  await assert.rejects(
    () => memory.recordEvent(userContext(), { eventId: 'evt-stream-invalid', content: 'bad', is_stream_final: 'false' }),
    error => error.code === 'INVALID_STREAM_FINAL'
  );
});

test('system and tool event bodies are no-store by default', async () => {
  const { memory, state } = createHarness();
  for (const [eventId, eventRole, contentType] of [['evt-system-default', 'system', 'plain_text'], ['evt-tool-default', 'tool', 'tool_output']]) {
    const result = await memory.recordEvent(userContext(), { eventId, eventRole, contentType, content: 'untrusted event body' });
    assert.equal(result.result, 'accepted_no_store');
  }
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.outboxEvents.length, 0);
  assert.equal(state.auditEvents.every(item => item.noStoreReason === 'untrusted_event_role_default'), true);
});

test('async extraction candidate keeps source linkage until explicit promotion', async () => {
  const { memory } = createHarness();
  const event = await memory.recordEvent(userContext(), { eventId: 'evt-candidate', content: '请记住我喜欢红茶' });
  const candidate = await memory.createCandidate(userContext(), { sourceEventId: event.rawEventId, content: '喜欢红茶', memoryType: 'preference', sensitivity: 'S0' });
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.memory.trustLevel, 'agent_inferred');
  assert.equal(memory.list(userContext()).length, 0);
  const promoted = await memory.promoteCandidate(userContext(), candidate.memory.memoryId, { resourceRevision: candidate.memory.resourceRevision });
  assert.equal(promoted.status, 'active');
  assert.equal(memory.list(userContext())[0].content, '喜欢红茶');
  assert.deepEqual(memory.list(userContext())[0].sourceRefs, [event.rawEventId]);
});

test('explicit S0 memory is immediately read-your-write visible and tenant-bound', async () => {
  const { memory } = createHarness();
  const created = await memory.hold(userContext(), { memoryType: 'preference', content: '喜欢红茶', sensitivity: 'S0' });
  assert.equal(created.status, 'active');
  assert.equal(created.memory.sensitivity, 'S0');
  assert.equal(created.memory.sourceRefs.length, 1);
  const retrieved = memory.retrieve(userContext(), { query: '红茶', purpose: 'answer_user_query', consistencyToken: created.consistencyToken });
  assert.equal(retrieved.answerability, 'known');
  assert.equal(retrieved.items[0].content, '喜欢红茶');
  await assert.rejects(() => memory.hold(userContext(), { tenantId: 'tenant-b', content: '越权', sensitivity: 'S0' }), error => error.code === 'TENANT_CONTEXT_MISMATCH' && error.status === 403);
});

test('assertion content types accepted by the domain are persistable by the canonical schema', async () => {
  const { memory } = createHarness();
  const toolOutput = await memory.hold(userContext(), { content: '来自工具的结构化事实', content_type: 'tool_output', sensitivity: 'S0' });
  const quoted = await memory.hold(userContext(), { content: '用户引用的原话', content_type: 'quoted_content', sensitivity: 'S0' });
  assert.equal(toolOutput.memory.content, '来自工具的结构化事实');
  assert.equal(quoted.memory.content, '用户引用的原话');
});

test('S2 memory requires confirmation and becomes visible only after the exact revision is confirmed', async () => {
  const { memory } = createHarness();
  const pending = await memory.hold(userContext(), { memoryType: 'fact', content: '我有糖尿病', sensitivity: 'S2' });
  assert.equal(pending.status, 'pending_confirmation');
  assert.equal(memory.list(userContext()).length, 0);
  const confirmed = await memory.confirm(userContext(), pending.confirmation.id, { resourceRevision: 1 });
  assert.equal(confirmed.memory.status, 'active');
  assert.equal(memory.list(userContext()).length, 1);
  await assert.rejects(() => memory.confirm(userContext(), pending.confirmation.id, { resourceRevision: 1 }), error => error.code === 'CONFIRMATION_EXPIRED' || error.code === 'RESOURCE_REVISION_CONFLICT');
});

test('relationship memory is isolated to the exact agent while user-scope access needs a grant', async () => {
  const { memory } = createHarness();
  const relationship = await memory.hold(userContext(), { scopeType: 'relationship', relationshipAgentId: 'agent-a', memoryType: 'relationship', content: '我们一起看过海边的日落', sensitivity: 'S0' });
  assert.equal(memory.list(agentContext('agent-a')).length, 1);
  assert.equal(memory.list(agentContext('agent-b')).length, 0);
  await memory.hold(userContext(), { scopeType: 'user', memoryType: 'preference', content: '喜欢海边', sensitivity: 'S0' });
  assert.equal(memory.list(agentContext('agent-a')).length, 1);
  await memory.grantUserScope(userContext(), { agentId: 'agent-a', permissions: ['retrieve', 'contextualize'] });
  assert.equal(memory.list(agentContext('agent-a')).length, 2);
  assert.ok(relationship.memory.scope.agentId === 'agent-a');
});

test('retrieve visibility does not grant governance mutation rights to an Agent', async () => {
  const { memory } = createHarness();
  const created = await memory.hold(userContext(), { content: '用户偏好', sensitivity: 'S0' });
  await memory.grantUserScope(userContext(), { agentId: 'agent-a', permissions: ['retrieve', 'contextualize'] });
  await assert.rejects(() => memory.correct(agentContext('agent-a'), created.memory.memoryId, { resourceRevision: created.memory.resourceRevision, content: '越权修改' }), error => error.code === 'GOVERNANCE_FORBIDDEN' && error.status === 403);
});

test('source-event forget hides derived assertions and fences old outbox work', async () => {
  const { memory, state } = createHarness();
  const event = await memory.recordEvent(userContext(), { eventId: 'evt-forget-source', content: '来源事实' });
  const created = await memory.hold(userContext(), { content: '来源事实', sensitivity: 'S0', sourceEventId: event.rawEventId });
  const result = await memory.forgetSourceEvent(userContext(), event.rawEventId, { resourceRevision: 1 });
  assert.equal(result.status, 'forgotten');
  assert.equal(memory.get(userContext(), created.memory.memoryId), null);
  assert.equal(state.tombstones.at(-1).targetType, 'source_event');
  assert.equal(state.outboxEvents[0].result, 'redacted');
});

test('session forget hides session assertions and current state', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const scoped = await memory.hold(userContext('user-a', { sessionId: session.id }), { scopeType: 'session', sessionId: session.id, content: 'session-only fact', sensitivity: 'S0', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: 'temporary', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  const result = await memory.forgetSession(userContext(), session.id, { resourceRevision: session.resourceRevision });
  assert.equal(result.status, 'forgotten');
  assert.equal(memory.get(userContext('user-a', { sessionId: session.id }), scoped.memory.memoryId), null);
  assert.equal(state.currentStates[0].status, 'forgotten');
});

test('relationship and account forget invalidate all derived visibility', async () => {
  const { memory, state } = createHarness();
  const relationship = await memory.hold(userContext(), { scopeType: 'relationship', relationshipAgentId: 'agent-a', content: '关系事实', sensitivity: 'S0' });
  await memory.hold(userContext(), { content: '用户事实', sensitivity: 'S0' });
  const relationshipResult = await memory.forgetRelationship(userContext(), 'agent-a');
  assert.equal(relationshipResult.status, 'forgotten');
  assert.equal(memory.get(userContext(), relationship.memory.memoryId), null);
  const accountResult = await memory.forgetAccount(userContext());
  assert.equal(accountResult.status, 'forgotten');
  assert.equal(memory.list(userContext()).length, 0);
  assert.equal(state.tombstones.at(-1).targetType, 'account');
});

test('correction versions the fact, pin keeps the chosen version, and forget hides it immediately', async () => {
  const { memory } = createHarness();
  const created = await memory.hold(userContext(), { memoryType: 'preference', content: '喜欢红茶', sensitivity: 'S0' });
  const pinned = await memory.pin(userContext(), created.memory.memoryId, { resourceRevision: created.memory.resourceRevision });
  const corrected = await memory.correct(userContext(), created.memory.memoryId, { resourceRevision: pinned.memory.resourceRevision, content: '现在更喜欢乌龙茶' });
  assert.equal(corrected.memory.content, '现在更喜欢乌龙茶');
  assert.equal(corrected.memory.pinnedVersionId, created.memory.versionId);
  assert.equal(memory.list(userContext())[0].content, '现在更喜欢乌龙茶');
  const forgotten = await memory.forget(userContext(), created.memory.memoryId, { resourceRevision: corrected.memory.resourceRevision });
  assert.equal(forgotten.status, 'forgotten');
  assert.equal(memory.get(userContext(), created.memory.memoryId), null);
  const governanceView = memory.get(userContext(), created.memory.memoryId, { purpose: 'governance' });
  assert.equal(governanceView.status, 'forgotten');
  assert.equal(governanceView.content, null);
});

test('S2 correction keeps the old version until confirmation and cannot bypass the policy gate', async () => {
  const { memory, state } = createHarness();
  const created = await memory.hold(userContext(), { memoryType: 'fact', content: '普通事实', sensitivity: 'S0' });
  const corrected = await memory.correct(userContext(), created.memory.memoryId, { resourceRevision: created.memory.resourceRevision, content: '我的诊断信息' });
  assert.equal(corrected.status, 'pending_confirmation');
  assert.equal(corrected.memory.content, '普通事实');
  const proposed = state.assertionVersions.find(version => version.id === corrected.confirmation.candidateVersionId);
  assert.equal(proposed.versionStatus, 'proposed');
  assert.equal(memory.retrieve(userContext(), { query: '诊断', purpose: 'answer_user_query' }).items.length, 0);

  const confirmed = await memory.confirm(userContext(), corrected.confirmation.id, { resourceRevision: corrected.confirmation.resourceRevision });
  assert.equal(confirmed.memory.content, '我的诊断信息');
  assert.equal(confirmed.memory.sensitivity, 'S2');
  assert.equal(confirmed.memory.directQueryPolicy, 'require_confirmation');
  const blocked = memory.retrieve(userContext(), { query: '诊断', purpose: 'answer_user_query' });
  assert.equal(blocked.items.length, 0);
  assert.equal(blocked.blocks.length, 1);
});

test('S1 correction cannot promote long-term memory into a current-state sensitivity class', async () => {
  const { memory } = createHarness();
  const created = await memory.hold(userContext(), { content: '普通事实', sensitivity: 'S0' });
  await assert.rejects(
    () => memory.correct(userContext(), created.memory.memoryId, { resourceRevision: created.memory.resourceRevision, content: '短期状态', sensitivity: 'S1' }),
    error => error.code === 'S1_CURRENT_STATE_REQUIRED'
  );
});

test('confirmation is invalidated when its assertion changes before the decision', async () => {
  const { memory, state } = createHarness();
  const pending = await memory.hold(userContext(), { content: '我的诊断信息', sensitivity: 'S2' });
  const assertion = state.assertions.find(item => item.id === pending.memory.memoryId);
  assertion.resourceRevision += 1;
  await assert.rejects(
    () => memory.confirm(userContext(), pending.confirmation.id, { resourceRevision: pending.confirmation.resourceRevision }),
    error => error.code === 'RESOURCE_REVISION_CONFLICT' && error.status === 409 && error.currentResourceRevision === assertion.resourceRevision
  );
  assert.equal(assertion.status, 'pending_confirmation');
});

test('session current state has an explicit TTL and does not become a long-term assertion', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const current = await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '正在准备发布', expiresAt: new Date(Date.now() + 10_000).toISOString(), allowPersist: false });
  assert.equal(current.currentState.sessionId, session.id);
  assert.equal(state.assertions.length, 0);
  assert.equal(state.currentStates.length, 1);
});

test('current-state replacement uses resource_revision optimistic concurrency', async () => {
  const { memory } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const first = await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '第一状态', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const second = await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '第二状态', expiresAt: new Date(Date.now() + 60_000).toISOString(), resource_revision: first.currentState.resourceRevision });
  assert.equal(second.currentState.resourceRevision, 2);
  await assert.rejects(
    () => memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '过期写入', expiresAt: new Date(Date.now() + 60_000).toISOString(), resource_revision: 1 }),
    error => error.code === 'RESOURCE_REVISION_CONFLICT' && error.status === 409 && error.currentResourceRevision === 2
  );
});

test('user and relationship assertions created during a session keep their own non-session scope', async () => {
  const { memory } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const userMemory = await memory.hold(userContext('user-a', { sessionId: session.id }), { scopeType: 'user', content: '长期用户偏好', sensitivity: 'S0' });
  const relationship = await memory.hold(userContext('user-a', { sessionId: session.id }), { scopeType: 'relationship', relationshipAgentId: 'agent-a', content: '关系共同语境', sensitivity: 'S0' });
  assert.equal(userMemory.memory.scope.sessionId, null);
  assert.equal(relationship.memory.scope.sessionId, null);
});

test('session assertions are visible only inside their active session', async () => {
  const { memory } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const scoped = await memory.hold(userContext('user-a', { sessionId: session.id }), { scopeType: 'session', sessionId: session.id, content: '仅当前会话', sensitivity: 'S0', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(memory.get(userContext(), scoped.memory.memoryId), null);
  assert.equal(memory.get(userContext('user-a', { sessionId: session.id }), scoped.memory.memoryId).content, '仅当前会话');
  await memory.forgetSession(userContext(), session.id, { resourceRevision: session.resourceRevision });
  assert.equal(memory.get(userContext('user-a', { sessionId: session.id }), scoped.memory.memoryId), null);
});

test('retention sweep expires TTL data, confirmation candidates, and old source events', async () => {
  const { memory, state } = createHarness();
  const event = await memory.recordEvent(userContext(), { eventId: 'retention-event', content: '短期来源' });
  const sourced = await memory.hold(userContext(), { sourceEventId: event.rawEventId, content: '来源事实', sensitivity: 'S0' });
  const sensitive = await memory.hold(userContext(), { content: '家庭冲突待确认', sensitivity: 'S2' });
  const currentSession = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await memory.writeCurrentState(userContext('user-a', { sessionId: currentSession.id }), { value: '短期状态', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const idempotent = await memory.hold(userContext(), { content: '短期幂等记录', sensitivity: 'S0', idempotency_key: 'retention-idempotency' });
  const at = new Date(Date.now() + 60_000).toISOString();
  state.rawEvents.find(item => item.id === event.rawEventId).deleteAfter = at;
  state.confirmations.find(item => item.id === sensitive.confirmation.id).expiresAt = at;
  state.currentStates[0].expiresAt = at;
  state.idempotencyRecords.find(item => item.key === 'retention-idempotency').expiresAt = at;
  const swept = await memory.sweepRetention(userContext(), { now: at });
  assert.equal(swept.status, 'swept');
  assert.equal(state.rawEvents.some(item => item.id === event.rawEventId), false);
  assert.equal(state.assertions.some(item => item.id === sourced.memory.memoryId), false);
  assert.equal(state.confirmations.find(item => item.id === sensitive.confirmation.id).status, 'expired');
  assert.equal(state.currentStates[0].status, 'expired');
  assert.equal(state.idempotencyRecords.some(item => item.key === 'retention-idempotency'), false);
  assert.ok(idempotent.memory.memoryId);
});

test('retention sweep expires a session and its session-scoped memory', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const scoped = await memory.hold(userContext('user-a', { sessionId: session.id }), { scopeType: 'session', sessionId: session.id, content: '会话短期事实', sensitivity: 'S0', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '会话状态', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const at = new Date(Date.now() + 60_000).toISOString();
  state.sessions.find(item => item.id === session.id).expiresAt = at;
  const swept = await memory.sweepRetention(userContext(), { now: at });
  assert.equal(swept.sessions, 1);
  assert.equal(state.sessions[0].status, 'expired');
  assert.equal(state.assertions.find(item => item.id === scoped.memory.memoryId).status, 'expired');
  assert.equal(state.currentStates[0].status, 'expired');
  assert.equal(memory.get(userContext('user-a', { sessionId: session.id }), scoped.memory.memoryId), null);
});

test('S1 hold is redirected to session state and proactive mention respects mention policy', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const current = await memory.hold(userContext(), { scopeType: 'session', sessionId: session.id, content: '最近有点疲惫', sensitivity: 'S1', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  assert.equal(current.status, 'current_state');
  assert.equal(state.assertions.length, 0);
  const hidden = await memory.hold(userContext(), { content: '一个不应主动提及的偏好', sensitivity: 'S0', mentionPolicy: 'do_not_mention' });
  const proactive = memory.retrieve(userContext(), { query: '不应主动提及', purpose: 'proactive_mention' });
  assert.equal(proactive.items.length, 0);
  assert.equal(hidden.status, 'active');
});

test('proactive mention feature flag fails closed and recorded mentions honor cooldowns', async () => {
  const { memory, state } = createHarness();
  const created = await memory.hold(userContext(), { content: '可以主动提及的偏好', sensitivity: 'S0' });
  await memory.grantUserScope(userContext(), { agentId: 'agent-a', permissions: ['mention'] });
  const agent = agentContext('agent-a');
  const first = memory.retrieve(agent, { query: '主动提及的偏好', purpose: 'proactive_mention' });
  assert.equal(first.items.length, 1);
  const recorded = await memory.recordMention(agent, { memory_ids: [created.memory.memoryId], topic_key: 'preference:tea', cooldown_ms: 60 * 60 * 1000 });
  assert.equal(recorded.status, 'recorded');
  assert.deepEqual(recorded.recordedMemoryIds, [created.memory.memoryId]);
  const cooled = memory.retrieve(agent, { query: '主动提及的偏好', purpose: 'proactive_mention', topic_key: 'preference:tea' });
  assert.equal(cooled.items.length, 0);
  assert.equal(state.mentionCooldowns.length, 1);
  state.mentionCooldowns[0].cooldownUntil = new Date(Date.now() - 1).toISOString();
  assert.equal(memory.retrieve(agent, { query: '主动提及的偏好', purpose: 'proactive_mention', topic_key: 'preference:tea' }).items.length, 1);

  const disabled = createMemoryModule(state, async () => {}, { featureFlags: { proactiveMention: false } });
  const disabledResult = disabled.retrieve(agent, { query: '主动提及的偏好', purpose: 'proactive_mention' });
  assert.equal(disabledResult.serviceMode, 'feature_disabled');
  assert.equal(disabledResult.items.length, 0);
});

test('proactive mention recording rejects user actors and does not store topic content', async () => {
  const { memory, state } = createHarness();
  const created = await memory.hold(userContext(), { content: '普通偏好', sensitivity: 'S0' });
  await assert.rejects(
    () => memory.recordMention(userContext(), { memory_ids: [created.memory.memoryId], topic_key: '用户的原始主题' }),
    error => error.code === 'MENTION_ACTOR_REQUIRED'
  );
  assert.equal(state.mentionCooldowns.length, 0);
});

test('context bundle includes only non-expired current state for the active session', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '正在发布', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  const bundle = memory.contextBundle(userContext('user-a', { sessionId: session.id }), { tokenBudget: 1200 });
  assert.equal(bundle.currentState.length, 1);
  assert.equal(bundle.currentState[0].value, '正在发布');
  assert.equal(memory.contextBundle(userContext(), { tokenBudget: 1200 }).currentState.length, 0);
  state.sessions[0].status = 'closed';
  assert.equal(memory.contextBundle(userContext('user-a', { sessionId: session.id }), { tokenBudget: 1200 }).currentState.length, 0);
  state.sessions[0].status = 'active';
  assert.equal(memory.contextBundle(agentContext('agent-b', 'user-a', { sessionId: session.id }), { tokenBudget: 1200 }).currentState.length, 0);
});

test('state_current route retrieves the active session state with normalized evidence', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '正在发布版本', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  const result = memory.retrieve(userContext('user-a', { sessionId: session.id }), { query: '我正在发布什么', purpose: 'answer_user_query' });
  assert.equal(result.queryRoute, 'state_current');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].memoryType, 'current_state');
  assert.equal(result.items[0].content, '正在发布版本');
  assert.equal(result.items[0].scope.sessionId, session.id);
  assert.equal(memory.retrieve(userContext(), { query: '我正在发布什么', purpose: 'answer_user_query' }).items.length, 0);
  state.sessions[0].status = 'closed';
  assert.equal(memory.retrieve(userContext('user-a', { sessionId: session.id }), { query: '我正在发布什么', purpose: 'answer_user_query' }).items.length, 0);
  state.sessions[0].status = 'active';
  assert.equal(memory.retrieve(agentContext('agent-b', 'user-a', { sessionId: session.id }), { query: '我正在发布什么', purpose: 'answer_user_query' }).items.length, 0);
});

test('current state can retain a normalized raw-event source link', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const event = await memory.recordEvent(userContext('user-a', { sessionId: session.id }), { eventId: 'state-source-event', sessionId: session.id, content: '正在发布版本' });
  const written = await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: '正在发布', sourceEventId: event.rawEventId, expiresAt: new Date(Date.now() + 10_000).toISOString() });
  assert.equal(state.currentStateSources.length, 1);
  assert.equal(state.currentStateSources[0].currentStateId, written.currentState.id);
  assert.equal(state.currentStateSources[0].userId, 'user-a');
  assert.equal(state.currentStateSources[0].rawEventId, event.rawEventId);
});

test('serialized memory keeps assertion confidence after a canonical reload shape', async () => {
  const memory = createMemoryModule(createMemoryModuleState());
  const created = await memory.hold(userContext(), { content: '喜欢红茶', sensitivity: 'S0', confidence: 0.73 });
  assert.equal(created.memory.confidence, 0.73);
  const reloaded = createMemoryModule({
    ...memory.state,
    assertionVersions: memory.state.assertionVersions.map(({ confidence, ...version }) => version)
  });
  assert.equal(reloaded.get(userContext(), created.memory.memoryId).confidence, 0.73);
});

test('context bundle preserves pinned core and evidence while compacting to budget', async () => {
  const { memory } = createHarness();
  const created = await memory.hold(userContext(), { memoryType: 'fact', content: '核心记忆'.repeat(400), sensitivity: 'S0' });
  await memory.pin(userContext(), created.memory.memoryId, { resourceRevision: created.memory.resourceRevision });
  const bundle = memory.contextBundle(userContext(), { query: '核心记忆', tokenBudget: 420 });
  assert.equal(bundle.tokenCount <= bundle.tokenBudget, true);
  assert.equal(bundle.coreMemory.length, 1);
  assert.equal(bundle.coreMemory[0].memoryId, created.memory.memoryId);
  assert.equal(bundle.evidence.some(item => item.memoryId === created.memory.memoryId), true);
  assert.equal(bundle.truncated, true);
});

test('context bundle rejects an impossible token budget instead of exceeding it', async () => {
  const { memory } = createHarness();
  assert.throws(() => memory.contextBundle(userContext(), { tokenBudget: 1 }), error => error.code === 'TOKEN_BUDGET_TOO_SMALL' && error.status === 400);
});

test('profile snapshot stays stable within a session while forget remains an immediate override', async () => {
  const { memory } = createHarness();
  const before = await memory.hold(userContext(), { memoryType: 'preference', content: '会话开始前的偏好', sensitivity: 'S0' });
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const after = await memory.hold(userContext(), { memoryType: 'preference', content: '会话开始后的偏好', sensitivity: 'S0' });
  const firstBundle = memory.contextBundle(userContext('user-a', { sessionId: session.id }), {});
  assert.equal(firstBundle.profileSnapshotId, session.profileSnapshotId);
  assert.ok(firstBundle.userProfile.some(item => item.memoryId === before.memory.memoryId));
  assert.equal(firstBundle.userProfile.some(item => item.memoryId === after.memory.memoryId), false);
  await memory.forget(userContext(), before.memory.memoryId, { resourceRevision: before.memory.resourceRevision });
  const afterForget = memory.contextBundle(userContext('user-a', { sessionId: session.id }), {});
  assert.equal(afterForget.userProfile.some(item => item.memoryId === before.memory.memoryId), false);
});

test('context bundle fails closed when an active session snapshot is missing', async () => {
  const { memory, state } = createHarness();
  const before = await memory.hold(userContext(), { memoryType: 'preference', content: '固定画像内容', sensitivity: 'S0' });
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  state.profileSnapshots = state.profileSnapshots.filter(item => item.id !== session.profileSnapshotId);
  const bundle = memory.contextBundle(userContext('user-a', { sessionId: session.id }), {});
  assert.equal(bundle.profileSnapshotId, null);
  assert.equal(bundle.userProfile.some(item => item.memoryId === before.memory.memoryId), false);
});

test('delete returns a trackable operation and leaves a tombstone without a readable copy', async () => {
  const { memory, state } = createHarness();
  const created = await memory.hold(userContext(), { memoryType: 'fact', content: '删除测试', sensitivity: 'S0' });
  const deleted = await memory.remove(userContext(), created.memory.memoryId, { resourceRevision: created.memory.resourceRevision });
  assert.equal(deleted.status, 'completed');
  assert.equal(memory.get(userContext(), created.memory.memoryId), null);
  assert.equal(memory.getDeletionOperation(userContext(), deleted.deletionOperationId).status, 'completed');
  assert.equal(state.tombstones.at(-1).action, 'delete');
});

test('physical memory delete removes every derived reference', async () => {
  const { memory, state } = createHarness();
  const created = await memory.hold(userContext(), { memoryType: 'fact', content: '删除全部派生引用', sensitivity: 'S0' });
  const assertionId = created.memory.memoryId;
  const versionId = created.memory.versionId;
  state.profileSnapshots = [{ id: 'snapshot-memory-delete', tenantId: 'tenant-a', userId: 'user-a', sessionId: null }];
  state.profileSnapshotItems = [{ snapshotId: 'snapshot-memory-delete', assertionId, versionId }];
  state.profileProjections = [{ id: 'projection-memory-delete', tenantId: 'tenant-a', userId: 'user-a', status: 'active' }];
  state.profileProjectionItems = [{ projectionId: 'projection-memory-delete', assertionId, versionId }];
  state.indexDocuments = [{ id: 'index-memory-delete', sourceId: assertionId, sourceVersion: versionId }];
  state.episodes = [{ id: 'episode-memory-delete', status: 'active' }];
  state.episodeMembers = [{ id: 'member-memory-delete', episodeId: 'episode-memory-delete', assertionVersionId: versionId }];
  state.confirmations = [{ id: 'confirmation-memory-delete', candidateAssertionId: assertionId, candidateVersionId: versionId }];
  state.accessConfirmations = [{ id: 'access-memory-delete', memoryIds: [assertionId] }];
  state.pins = [{ id: 'pin-memory-delete', assertionId }];
  state.outboxEvents.push({ id: 'outbox-memory-delete', aggregateId: assertionId, status: 'pending' });

  const deleted = await memory.remove(userContext(), assertionId, { resourceRevision: created.memory.resourceRevision });

  assert.equal(deleted.status, 'completed');
  assert.equal(state.assertions.some(item => item.id === assertionId), false);
  assert.equal(state.assertionVersions.some(item => item.id === versionId), false);
  assert.equal(state.profileSnapshotItems.some(item => item.assertionId === assertionId), false);
  assert.equal(state.profileProjectionItems.some(item => item.assertionId === assertionId), false);
  assert.equal(state.profileProjections.find(item => item.id === 'projection-memory-delete').status, 'invalidated');
  assert.equal(state.indexDocuments.some(item => item.sourceId === assertionId), false);
  assert.equal(state.episodeMembers.some(item => item.assertionVersionId === versionId), false);
  assert.equal(state.episodes.some(item => item.id === 'episode-memory-delete'), false);
  assert.equal(state.confirmations.some(item => item.candidateAssertionId === assertionId), false);
  assert.equal(state.accessConfirmations.some(item => item.memoryIds?.includes(assertionId)), false);
  assert.equal(state.pins.some(item => item.assertionId === assertionId), false);
  assert.equal(state.outboxEvents.some(item => item.aggregateId === assertionId), false);
});

test('physical source-event delete removes raw content, source-linked versions, derived references, and queued work', async () => {
  const { memory, state } = createHarness();
  const event = await memory.recordEvent(userContext(), { eventId: 'evt-delete-source', content: '需要物理删除的来源' });
  const created = await memory.hold(userContext(), { content: '来源记忆', sourceEventId: event.rawEventId, sensitivity: 'S0' });
  const deleted = await memory.deleteSourceEvent(userContext(), event.rawEventId, { resourceRevision: 1 });
  assert.equal(deleted.status, 'completed');
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.assertions.length, 0);
  assert.equal(state.assertionVersions.length, 0);
  assert.equal(state.assertionVersionSources.length, 0);
  assert.equal(state.outboxEvents.some(item => item.aggregateId === event.rawEventId || item.aggregateId === created.memory.memoryId), false);
  assert.equal(memory.getDeletionOperation(userContext(), deleted.deletionOperationId).targetType, 'source_event');
  assert.equal(state.tombstones.at(-1).action, 'delete');
});

test('physical session delete removes session-scoped assertions, events, state, snapshots, and episodes', async () => {
  const { memory, state } = createHarness();
  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const scopedEvent = await memory.recordEvent(userContext('user-a', { sessionId: session.id }), { eventId: 'evt-delete-session', content: 'session source', sessionId: session.id });
  const scoped = await memory.hold(userContext('user-a', { sessionId: session.id }), { scopeType: 'session', sessionId: session.id, content: 'session memory', sensitivity: 'S0', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  await memory.writeCurrentState(userContext('user-a', { sessionId: session.id }), { value: 'temporary state', expiresAt: new Date(Date.now() + 10_000).toISOString() });
  const deleted = await memory.deleteSession(userContext(), session.id, { resourceRevision: session.resourceRevision });
  assert.equal(deleted.status, 'completed');
  assert.equal(state.sessions.length, 0);
  assert.equal(state.rawEvents.some(event => event.id === scopedEvent.rawEventId), false);
  assert.equal(state.assertions.some(assertion => assertion.id === scoped.memory.memoryId), false);
  assert.equal(state.currentStates.length, 0);
  assert.equal(state.profileSnapshots.length, 0);
  assert.equal(memory.getDeletionOperation(userContext(), deleted.deletionOperationId).targetType, 'session');
});

test('physical relationship delete removes only the exact relationship scope', async () => {
  const { memory, state } = createHarness();
  const relationship = await memory.hold(userContext(), { scopeType: 'relationship', relationshipAgentId: 'agent-a', content: '关系范围内容', sensitivity: 'S0' });
  const userMemory = await memory.hold(userContext(), { scopeType: 'user', content: '用户范围内容', sensitivity: 'S0' });
  const deleted = await memory.deleteRelationship(userContext(), 'agent-a');
  assert.equal(deleted.status, 'completed');
  assert.equal(state.assertions.some(assertion => assertion.id === relationship.memory.memoryId), false);
  assert.equal(memory.get(userContext(), userMemory.memory.memoryId).content, '用户范围内容');
  assert.equal(memory.getDeletionOperation(userContext(), deleted.deletionOperationId).targetType, 'relationship');
});

test('physical account delete clears user data but preserves a minimal deletion ledger', async () => {
  const { memory, state } = createHarness();
  await memory.recordEvent(userContext(), { eventId: 'evt-delete-account', content: 'account source' });
  await memory.hold(userContext(), { content: 'account memory', sensitivity: 'S0' });
  const deleted = await memory.deleteAccount(userContext());
  assert.equal(deleted.status, 'completed');
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.assertions.length, 0);
  assert.equal(state.assertionVersions.length, 0);
  assert.equal(state.outboxEvents.length, 0);
  assert.equal(state.idempotencyRecords.length, 0);
  assert.equal(state.deletionOperations.length, 1);
  assert.equal(state.tombstones.length, 1);
  assert.equal(state.tombstones[0].targetType, 'account');
  assert.equal(memory.getDeletionOperation(userContext(), deleted.deletionOperationId).redactionEpoch, deleted.redactionEpoch);
});

test('physical account delete is scoped to the target tenant and user', async () => {
  const { memory, state } = createHarness();
  const otherUser = userContext('user-b');
  const otherTenant = { tenantId: 'tenant-b', subjectUserId: 'user-b', actorType: 'user', actorId: 'user-b' };
  await memory.recordEvent(userContext(), { eventId: 'account-scope-a', content: 'target account event' });
  const targetMemory = await memory.hold(userContext(), { content: 'target account memory', sensitivity: 'S0' });
  await memory.recordEvent(otherUser, { eventId: 'account-scope-b', content: 'other user event' });
  const otherMemory = await memory.hold(otherUser, { content: 'other user memory', sensitivity: 'S0' });
  await memory.recordEvent(otherTenant, { eventId: 'account-scope-c', content: 'other tenant event' });
  const otherTenantMemory = await memory.hold(otherTenant, { content: 'other tenant memory', sensitivity: 'S0' });
  const otherUserDelete = await memory.deleteAccount(otherUser);

  const deleted = await memory.deleteAccount(userContext());

  assert.equal(state.rawEvents.some(item => item.userId === 'user-a'), false);
  assert.equal(state.assertions.some(item => item.id === targetMemory.memory.memoryId), false);
  assert.equal(state.rawEvents.some(item => item.userId === 'user-b' && item.tenantId === 'tenant-a'), false);
  assert.equal(state.assertions.some(item => item.id === otherMemory.memory.memoryId), false);
  assert.equal(state.rawEvents.some(item => item.userId === 'user-b' && item.tenantId === 'tenant-b'), true);
  assert.equal(state.assertions.some(item => item.id === otherTenantMemory.memory.memoryId), true);
  assert.equal(state.deletionOperations.some(item => item.id === otherUserDelete.deletionOperationId), true);
  assert.equal(state.deletionOperations.some(item => item.id === deleted.deletionOperationId), true);
  assert.equal(state.tombstones.some(item => item.targetType === 'account' && item.tenantId === 'tenant-a' && item.userId === 'user-b'), true);
  assert.equal(state.tombstones.some(item => item.targetType === 'account' && item.tenantId === 'tenant-a' && item.userId === 'user-a'), true);
});

test('hybrid and vector retrieval flags change the async query path and fall back safely', async () => {
  const { state } = createHarness();
  const base = createMemoryModule(state);
  const tea = await base.hold(userContext(), { content: '喜欢红茶', sensitivity: 'S0' });
  const coffee = await base.hold(userContext(), { content: '喜欢咖啡', sensitivity: 'S0' });
  const teaVersion = state.assertionVersions.find(version => version.id === tea.memory.versionId);
  const coffeeVersion = state.assertionVersions.find(version => version.id === coffee.memory.versionId);
  state.indexDocuments = [
    { sourceId: tea.memory.memoryId, sourceVersion: teaVersion.id, indexStatus: 'active', embedding: [1, 0] },
    { sourceId: coffee.memory.memoryId, sourceVersion: coffeeVersion.id, indexStatus: 'active', embedding: [0, 1] }
  ];
  const hybrid = createMemoryModule(state, async () => {}, { featureFlags: { hybridRetrieval: true }, embeddingGateway: { embed: async () => [0, 1] } });
  const hybridResult = await hybrid.retrieveAsync(userContext(), { query: '红茶' });
  assert.equal(hybridResult.retrievalMode, 'hybrid_rrf');
  const vectorOnly = createMemoryModule(state, async () => {}, { featureFlags: { vectorRetrieval: true }, embeddingGateway: { embed: async () => [0, 1] } });
  const vectorResult = await vectorOnly.retrieveAsync(userContext(), { query: '没有词面匹配' });
  assert.equal(vectorResult.retrievalMode, 'vector');
  const fallback = createMemoryModule(state, async () => {}, { featureFlags: { hybridRetrieval: true }, embeddingGateway: { embed: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); } } });
  const fallbackResult = await fallback.retrieveAsync(userContext(), { query: '红茶' });
  assert.equal(fallbackResult.retrievalMode, 'bm25_embedding_timeout');
});

test('native retrieval hook feeds version and source evidence through final policy handling', async () => {
  const state = createMemoryModuleState();
  const base = createMemoryModule(state);
  const created = await base.hold(userContext(), { content: '喜欢红茶', sensitivity: 'S0' });
  const assertion = state.assertions.find(item => item.id === created.memory.memoryId);
  const version = state.assertionVersions.find(item => item.id === created.memory.versionId);
  const native = createMemoryModule(state, async () => {}, {
    nativeRetriever: async () => ({
      retrievalMode: 'postgres_vector',
      items: [{
        id: assertion.id,
        score: 0.91,
        assertion,
        version,
        sourceRefs: ['native-source-a']
      }]
    })
  });
  const result = await native.retrieveAsync(userContext(), { query: '茶' });
  assert.equal(result.retrievalMode, 'postgres_vector');
  assert.equal(result.items[0].content, '喜欢红茶');
  assert.deepEqual(result.items[0].sourceRefs, ['native-source-a']);
});

test('context bundle recalls generated episodes with member evidence and respects agent grants', async () => {
  const { memory, state } = createHarness();
  await memory.recordEvent(userContext(), { eventId: 'episode-event-1', content: '讨论恢复演练', occurredAt: '2026-08-22T00:00:00.000Z' });
  await memory.recordEvent(userContext(), { eventId: 'episode-event-2', content: '完成恢复演练验收', occurredAt: '2026-08-22T00:10:00.000Z' });
  rebuildEpisodes(state, { tenantId: 'tenant-a', userId: 'user-a' });
  const bundle = memory.contextBundle(userContext(), { query: '恢复演练' });
  assert.equal(bundle.relevantEpisodes.length, 1);
  assert.equal(bundle.relevantEpisodes[0].memberEventIds.length, 2);
  assert.equal(bundle.evidence.some(item => item.episodeId === bundle.relevantEpisodes[0].episodeId), true);
  const agentBundle = memory.contextBundle(agentContext('agent-a'), { query: '恢复演练' });
  assert.equal(agentBundle.relevantEpisodes.length, 0);

  const session = await memory.createSession(userContext(), { callerAgentId: 'agent-a', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const sessionEvent = await memory.recordEvent(userContext('user-a', { sessionId: session.id }), { eventId: 'session-episode-event', sessionId: session.id, content: '仅当前会话可见' });
  state.episodes.push({ id: 'session-episode-only', tenantId: 'tenant-a', userId: 'user-a', scopeType: 'session', sessionId: session.id, title: '仅会话摘要', summary: '仅当前会话可见', observedStart: new Date().toISOString(), observedEnd: new Date().toISOString(), groupingRuleVersion: 'test', status: 'active' });
  state.episodeMembers.push({ id: 'session-episode-member', episodeId: 'session-episode-only', rawEventId: sessionEvent.rawEventId, assertionVersionId: null });
  assert.equal(memory.contextBundle(userContext(), { query: '仅当前会话可见' }).relevantEpisodes.some(item => item.episodeId === 'session-episode-only'), false);
  assert.equal(memory.contextBundle(userContext('user-a', { sessionId: session.id }), { query: '仅当前会话可见' }).relevantEpisodes.some(item => item.episodeId === 'session-episode-only'), true);
  state.sessions.find(item => item.id === session.id).status = 'closed';
  assert.equal(memory.contextBundle(userContext('user-a', { sessionId: session.id }), { query: '仅当前会话可见' }).relevantEpisodes.some(item => item.episodeId === 'session-episode-only'), false);
});

test('context bundle does not expose a mixed episode containing an S2 source event', async () => {
  const { memory, state } = createHarness();
  const safe = await memory.recordEvent(userContext(), { eventId: 'episode-safe', content: '普通恢复演练' });
  const sensitive = await memory.recordEvent(userContext(), { eventId: 'episode-sensitive', content: '我的诊断信息' });
  state.episodes.push({ id: 'mixed-sensitive-episode', tenantId: 'tenant-a', userId: 'user-a', scopeType: 'user', sessionId: null, title: '恢复演练', summary: '普通恢复演练；我的诊断信息', observedStart: new Date().toISOString(), observedEnd: new Date().toISOString(), groupingRuleVersion: 'test', status: 'active' });
  state.episodeMembers.push(
    { id: 'mixed-safe-member', episodeId: 'mixed-sensitive-episode', rawEventId: safe.rawEventId, assertionVersionId: null },
    { id: 'mixed-sensitive-member', episodeId: 'mixed-sensitive-episode', rawEventId: sensitive.rawEventId, assertionVersionId: null }
  );
  const bundle = memory.contextBundle(userContext(), { query: '恢复演练' });
  assert.equal(bundle.relevantEpisodes.some(item => item.episodeId === 'mixed-sensitive-episode'), false);
});

test('context bundle excludes do-not-mention and unconfirmed direct-query memories unless directly authorized', async () => {
  const { memory } = createHarness();
  const hidden = await memory.hold(userContext(), { content: '不要主动提及的偏好', sensitivity: 'S0', mentionPolicy: 'do_not_mention' });
  const contextualizable = await memory.hold(userContext(), { content: '只用于上下文的偏好', sensitivity: 'S0', mentionPolicy: 'contextualizable_only' });
  const sensitive = await memory.hold(userContext(), { content: '我的诊断信息', sensitivity: 'S2' });
  await memory.confirm(userContext(), sensitive.confirmation.id, { resourceRevision: sensitive.confirmation.resourceRevision });

  const ordinary = memory.contextBundle(userContext(), {});
  assert.equal(ordinary.userProfile.some(item => item.memoryId === hidden.memory.memoryId), false);
  assert.equal(ordinary.userProfile.some(item => item.memoryId === contextualizable.memory.memoryId), true);
  assert.equal(ordinary.userProfile.some(item => item.memoryId === sensitive.memory.memoryId), false);

  const unrelated = memory.contextBundle(userContext(), { query: '普通问题' });
  assert.equal(unrelated.userProfile.some(item => item.memoryId === hidden.memory.memoryId), false);
  assert.equal(unrelated.userProfile.some(item => item.memoryId === sensitive.memory.memoryId), false);

  const direct = memory.contextBundle(userContext(), { query: '诊断信息' });
  assert.equal(direct.userProfile.some(item => item.memoryId === sensitive.memory.memoryId), false);
  assert.equal(direct.blocks.length, 1);
  const access = await memory.confirmAccess(userContext(), direct.blocks[0].accessConfirmationId);
  const authorized = memory.contextBundle(userContext(), { query: '诊断信息', accessToken: access.accessToken });
  assert.equal(authorized.evidence.some(item => item.memoryId === sensitive.memory.memoryId), true);
});

test('episode summaries cannot bypass a hidden policy on their source assertion', async () => {
  const { memory, state } = createHarness();
  const event = await memory.recordEvent(userContext(), { eventId: 'hidden-episode-source', content: '隐藏来源偏好' });
  const hidden = await memory.hold(userContext(), { content: '隐藏来源偏好', sourceEventId: event.rawEventId, sensitivity: 'S0', mentionPolicy: 'do_not_mention' });
  state.episodes.push({ id: 'hidden-source-episode', tenantId: 'tenant-a', userId: 'user-a', scopeType: 'user', sessionId: null, title: '隐藏来源偏好', summary: '隐藏来源偏好', observedStart: new Date().toISOString(), observedEnd: new Date().toISOString(), groupingRuleVersion: 'test', status: 'active' });
  state.episodeMembers.push({ id: 'hidden-source-member', episodeId: 'hidden-source-episode', rawEventId: event.rawEventId, assertionVersionId: null });
  const bundle = memory.contextBundle(userContext(), { query: '隐藏来源偏好' });
  assert.equal(bundle.relevantEpisodes.some(item => item.episodeId === 'hidden-source-episode'), false);
  assert.equal(bundle.items, undefined);
  assert.ok(hidden.memory.memoryId);
});
