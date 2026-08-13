import test from 'node:test';
import assert from 'node:assert/strict';

const apiBase = process.env.COCHPIA_TEST_API || 'http://localhost:8787';
const userAToken = process.env.TEST_USER_A_TOKEN;
const userBToken = process.env.TEST_USER_B_TOKEN;
const canRun = Boolean(userAToken && userBToken && process.env.AUTH_MODE === 'required' && process.env.STORAGE_PROVIDER === 'postgres');

async function request(path, token, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test('two-user isolation acceptance', { skip: !canRun && 'requires a running PostgreSQL API and TEST_USER_A_TOKEN/TEST_USER_B_TOKEN' }, async () => {
  const created = await request('/api/sessions', userAToken, {
    method: 'POST',
    body: JSON.stringify({ title: `isolation-${Date.now()}` })
  });
  assert.equal(created.response.status, 201);
  const sessionId = created.body.id;

  const userAList = await request('/api/sessions', userAToken);
  assert.equal(userAList.response.status, 200);
  assert.ok(userAList.body.some(session => session.id === sessionId));

  const userBSession = await request(`/api/sessions/${sessionId}/messages`, userBToken);
  assert.ok([403, 404].includes(userBSession.response.status));

  const userBMemory = await request('/api/memories', userBToken);
  assert.equal(userBMemory.response.status, 200);
  assert.ok(!userBMemory.body.some(memory => memory.source === `chat:${sessionId}`));

  const userBPersonality = await request('/api/personality', userBToken);
  assert.equal(userBPersonality.response.status, 200);
  assert.notEqual(userBPersonality.body.evidenceCount, undefined);

  const deletedByB = await request(`/api/sessions/${sessionId}`, userBToken, { method: 'DELETE' });
  assert.ok([403, 404].includes(deletedByB.response.status));

  const userAStillOwns = await request(`/api/sessions/${sessionId}/messages`, userAToken);
  assert.equal(userAStillOwns.response.status, 200);
});
