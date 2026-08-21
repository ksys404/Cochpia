import test from 'node:test';
import assert from 'node:assert/strict';

const apiBase = process.env.COCHPIA_TEST_API || 'http://localhost:8787';
const userAToken = process.env.TEST_USER_A_TOKEN;
const userBToken = process.env.TEST_USER_B_TOKEN;
const canRun = process.env.RUN_API_INTEGRATION === 'true' && process.env.AUTH_MODE === 'required' && process.env.STORAGE_PROVIDER === 'postgres' && userAToken && userBToken;

async function request(path, token, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

test('Regenerate API acceptance: missing target', { skip: !canRun && 'requires an isolated integration environment' }, async () => {
  const result = await request('/api/chat/regenerate', userAToken, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'missing-session', messageId: 'missing-message' })
  });
  assert.ok([403, 404].includes(result.response.status));
});

test('Regenerate API acceptance: success, ownership, concurrency, and model failure', { skip: !canRun && 'requires an isolated integration environment' }, async () => {
  const created = await request('/api/sessions', userAToken, { method: 'POST', body: JSON.stringify({ title: `regenerate-${Date.now()}` }) });
  assert.equal(created.response.status, 201);
  const sessionId = created.body.id;

  const stream = await fetch(`${apiBase}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userAToken}` },
    body: JSON.stringify({ sessionId, message: 'integration regenerate fixture' })
  });
  assert.equal(stream.status, 200);
  await stream.text();
  const messages = await request(`/api/sessions/${sessionId}/messages`, userAToken);
  const assistant = messages.body.find(message => message.role === 'assistant' && message.id !== 'm-1');
  assert.ok(assistant);

  const retry = await fetch(`${apiBase}/api/chat/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userAToken}` },
    body: JSON.stringify({ sessionId, messageId: assistant.id })
  });
  assert.equal(retry.status, 200);
  const retryBody = await retry.text();
  assert.match(retryBody, /event: meta/);
  assert.match(retryBody, /"retry":true/);

  const regenerated = await fetch(`${apiBase}/api/chat/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userAToken}` },
    body: JSON.stringify({ sessionId, messageId: assistant.id })
  });
  assert.equal(regenerated.status, 200);
  const regeneratedBody = await regenerated.text();
  assert.match(regeneratedBody, /event: meta/);
  assert.match(regeneratedBody, /event: done/);

  const concurrent = await Promise.all([1, 2].map(() => fetch(`${apiBase}/api/chat/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userAToken}` },
    body: JSON.stringify({ sessionId, messageId: assistant.id })
  })));
  const concurrentStatuses = concurrent.map(response => response.status);
  assert.ok(concurrentStatuses.includes(409), `expected one concurrent request to be rejected, got ${concurrentStatuses.join(',')}`);
  await Promise.all(concurrent.map(response => response.text()));

  const crossUser = await request('/api/chat/regenerate', userBToken, {
    method: 'POST',
    body: JSON.stringify({ sessionId, messageId: assistant.id })
  });
  assert.ok([403, 404].includes(crossUser.response.status));

  const invalidModel = await fetch(`${apiBase}/api/chat/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userAToken}` },
    body: JSON.stringify({ sessionId, messageId: assistant.id, provider: 'unsupported-provider' })
  });
  assert.ok([400, 404, 409].includes(invalidModel.status));
});
