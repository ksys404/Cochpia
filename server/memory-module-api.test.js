import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleRouter } from './memory-module-api.js';

const context = { tenantId: 'tenant-api', subjectUserId: 'user-api', actorType: 'user', actorId: 'user-api', callerAgentId: null };

async function withApi(run) {
  const memory = createMemoryModule(createMemoryModuleState());
  const app = express();
  app.use(express.json());
  app.use('/v1', createMemoryModuleRouter({
    memoryModuleForRequest: () => memory,
    contextFromRequest: req => req.headers['x-test-actor'] === 'agent'
      ? { tenantId: context.tenantId, subjectUserId: context.subjectUserId, actorType: 'agent', actorId: 'agent-api', callerAgentId: 'agent-api' }
      : context
  }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

test('V1 HTTP contract supports write, retrieve, and read-your-write', async () => {
  await withApi(async base => {
    const created = await request(base, '/v1/memories', { method: 'POST', body: JSON.stringify({ memory_type: 'preference', content: '喜欢乌龙茶', sensitivity: 'S0' }) });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, 'active');
    assert.ok(created.body.consistencyToken.token);

    const retrieved = await request(base, '/v1/retrieve', { method: 'POST', body: JSON.stringify({ query: '我的乌龙茶偏好', purpose: 'answer_user_query', consistency_token: created.body.consistencyToken }) });
    assert.equal(retrieved.response.status, 200);
    assert.equal(retrieved.body.answerability, 'known');
    assert.equal(retrieved.body.queryRoute, 'profile_exact');
    assert.equal(retrieved.body.items[0].content, '喜欢乌龙茶');
  });
});

test('V1 mutation APIs support Idempotency-Key replay and conflict detection', async () => {
  await withApi(async base => {
    const first = await request(base, '/v1/memories', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-memory-create-1' },
      body: JSON.stringify({ content: 'HTTP 幂等内容', sensitivity: 'S0' })
    });
    const replay = await request(base, '/v1/memories', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-memory-create-1' },
      body: JSON.stringify({ content: 'HTTP 幂等内容', sensitivity: 'S0' })
    });
    assert.equal(first.response.status, 201);
    assert.equal(replay.response.status, 201);
    assert.equal(replay.body.memory.memoryId, first.body.memory.memoryId);

    const conflict = await request(base, '/v1/memories', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'http-memory-create-1' },
      body: JSON.stringify({ content: '不同内容', sensitivity: 'S0' })
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

    const mismatchedKeys = await request(base, '/v1/memories', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'header-key' },
      body: JSON.stringify({ idempotency_key: 'body-key', content: '不会写入', sensitivity: 'S0' })
    });
    assert.equal(mismatchedKeys.response.status, 400);
    assert.equal(mismatchedKeys.body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
  });
});

test('V1 HTTP contract uses stable error shape and does not accept body tenant overrides', async () => {
  await withApi(async base => {
    const mismatch = await request(base, '/v1/memories', { method: 'POST', body: JSON.stringify({ tenant_id: 'other-tenant', content: '越权', sensitivity: 'S0' }) });
    assert.equal(mismatch.response.status, 403);
    assert.equal(mismatch.body.error.code, 'TENANT_CONTEXT_MISMATCH');
    assert.equal(typeof mismatch.body.error.request_id, 'string');
    assert.equal(mismatch.body.error.retryable, false);

    const invalid = await request(base, '/v1/retrieve', { method: 'POST', body: JSON.stringify({ purpose: 'answer_user_query' }) });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_QUERY');
    assert.ok(Object.hasOwn(invalid.body.error, 'current_resource_revision'));
  });
});

test('V1 HTTP contract keeps S3 event content out of the stored response path', async () => {
  await withApi(async base => {
    const result = await request(base, '/v1/events', { method: 'POST', body: JSON.stringify({ event_id: 'evt-api-s3', content: 'AKIA1234567890ABCDEF' }) });
    assert.equal(result.response.status, 202);
    assert.equal(result.body.result, 'accepted_no_store');
    assert.equal(Object.hasOwn(result.body, 'content'), false);
  });
});

test('V1 HTTP contract records proactive mentions only for authorized Agent callers', async () => {
  await withApi(async base => {
    const created = await request(base, '/v1/memories', { method: 'POST', body: JSON.stringify({ content: '可主动提及的 API 偏好', sensitivity: 'S0' }) });
    const grant = await request(base, '/v1/access-grants', { method: 'POST', body: JSON.stringify({ agent_id: 'agent-api', permissions: ['mention'] }) });
    assert.equal(grant.response.status, 201);
    const recorded = await request(base, '/v1/mentions', { method: 'POST', headers: { 'x-test-actor': 'agent' }, body: JSON.stringify({ memory_ids: [created.body.memory.memoryId], topic_key: 'api:preference', cooldown_ms: 60000 }) });
    assert.equal(recorded.response.status, 200);
    assert.equal(recorded.body.status, 'recorded');
    const cooled = await request(base, '/v1/retrieve', { method: 'POST', headers: { 'x-test-actor': 'agent' }, body: JSON.stringify({ query: '主动提及的 API 偏好', purpose: 'proactive_mention', topic_key: 'api:preference' }) });
    assert.equal(cooled.body.items.length, 0);
  });
});

test('direct-query confirmation issues a one-time token bound to the current query session', async () => {
  await withApi(async base => {
    const created = await request(base, '/v1/memories', { method: 'POST', body: JSON.stringify({ content: '家庭冲突记录', sensitivity: 'S2' }) });
    const confirmed = await request(base, `/v1/confirmations/${created.body.confirmation.id}/confirm`, { method: 'POST', body: JSON.stringify({ resource_revision: 1 }) });
    assert.equal(confirmed.response.status, 200);
    const retrieved = await request(base, '/v1/retrieve', { method: 'POST', body: JSON.stringify({ query: '家庭冲突', purpose: 'answer_user_query' }) });
    assert.equal(retrieved.response.status, 200);
    assert.equal(retrieved.body.items.length, 0);
    assert.equal(retrieved.body.blocks.length, 1);
    const access = await request(base, `/v1/access-confirmations/${retrieved.body.blocks[0].accessConfirmationId}/confirm`, { method: 'POST' });
    assert.equal(access.response.status, 200);
    const allowed = await request(base, '/v1/retrieve', { method: 'POST', body: JSON.stringify({ query: '家庭冲突', purpose: 'answer_user_query', access_token: access.body.accessToken }) });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.items[0].content, '家庭冲突记录');
    const reused = await request(base, '/v1/retrieve', { method: 'POST', body: JSON.stringify({ query: '家庭冲突', purpose: 'answer_user_query', access_token: access.body.accessToken }) });
    assert.equal(reused.body.items.length, 0);
    assert.equal(reused.body.blocks.length, 1);
  });
});

test('V1 governance delete routes a physical source-event deletion and returns a deletion operation', async () => {
  await withApi(async base => {
    const event = await request(base, '/v1/events', { method: 'POST', body: JSON.stringify({ event_id: 'evt-delete-api', content: 'source content' }) });
    assert.equal(event.response.status, 202);
    const deleted = await request(base, '/v1/governance/delete', { method: 'POST', body: JSON.stringify({ target_type: 'source_event', target_id: event.body.rawEventId, resource_revision: 1 }) });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.status, 'completed');
    const operation = await request(base, `/v1/deletion-operations/${deleted.body.deletionOperationId}`);
    assert.equal(operation.response.status, 200);
    assert.equal(operation.body.action, 'delete');
    assert.equal(operation.body.targetType, 'source_event');
  });
});

test('list endpoints use stable opaque cursors and reject cursor/filter mismatches', async () => {
  await withApi(async base => {
    for (const content of ['第一页', '第二页', '第三页']) {
      const created = await request(base, '/v1/memories', { method: 'POST', body: JSON.stringify({ content, sensitivity: 'S0' }) });
      assert.equal(created.response.status, 201);
    }
    const first = await request(base, '/v1/memories?limit=1');
    assert.equal(first.response.status, 200);
    assert.equal(first.body.items.length, 1);
    assert.equal(typeof first.body.nextCursor, 'string');
    const second = await request(base, `/v1/memories?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.response.status, 200);
    assert.equal(second.body.items.length, 1);
    assert.notEqual(second.body.items[0].memoryId, first.body.items[0].memoryId);
    const invalid = await request(base, '/v1/memories?limit=1&cursor=not-a-cursor');
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_CURSOR');

    for (const content of ['家庭冲突', '另一条家庭冲突']) {
      const sensitive = await request(base, '/v1/memories', { method: 'POST', body: JSON.stringify({ content, sensitivity: 'S2' }) });
      assert.equal(sensitive.response.status, 201);
    }
    const confirmations = await request(base, '/v1/confirmations?limit=1');
    assert.equal(confirmations.response.status, 200);
    assert.equal(confirmations.body.items.length, 1);
    assert.equal(typeof confirmations.body.nextCursor, 'string');
  });
});
