import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRouter, redactHiddenMemoryContent, HIDDEN_MEMORY_STATUSES } from './routes/account.js';

const USER_ID = 'user-fixture';

const memoryModuleFixture = () => ({
  assertions: [
    { id: 'keep', status: 'active' },
    { id: 'gone', status: 'forgotten' },
    { id: 'revoked', status: 'revoked' }
  ],
  assertionVersions: [
    { id: 'v1', assertionId: 'keep', content: '记得你喜欢下雨天' },
    { id: 'v2', assertionId: 'gone', content: '这条应该被抹掉' },
    { id: 'v3', assertionId: 'revoked', content: '这条也应被抹掉' }
  ],
  sequence: 7
});

const buildApp = ({ memory, deleteUserState }) => {
  const deleted = [];
  const app = express();
  app.use(express.json());
  app.use('/', createRouter({
    state: {
      __userId: USER_ID,
      sessions: [{ id: 's1' }, { id: 's2' }],
      messages: { s1: [{ id: 'm1' }], s2: [] },
      agents: [{ id: 'a1' }],
      events: [{ id: 'e1' }],
      evidence: [],
      memoryModule: memoryModuleFixture()
    },
    fail: (res, status, code, message) => res.status(status).json({ error: { code, message } }),
    currentUserId: () => USER_ID,
    compatibilityMemoryForRequest: () => memory,
    deleteUserState: deleteUserState || (async userId => { deleted.push(userId); return { userStates: 1, users: 1, legacyRows: { cochpia_sessions: 2 } }; }),
    storageProvider: 'postgres'
  }));
  return { app, deleted };
};

const servers = [];
const listen = app => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => { servers.push(server); resolve(`http://127.0.0.1:${server.address().port}`); });
});
after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });

// 路由会打审计日志,测试里收走它们,顺便断言确实记了。
const collectLogs = () => {
  const original = { log: console.log, error: console.error };
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  return { lines, restore: () => Object.assign(console, original) };
};

test('export returns the whole account state with hidden memory content redacted', async () => {
  const { app } = buildApp({ memory: {} });
  const base = await listen(app);
  const response = await fetch(`${base}/api/account/export`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, 2);
  assert.equal(body.userId, USER_ID);
  assert.equal(body.storageProvider, 'postgres');
  assert.deepEqual(body.summary, { sessions: 2, messages: 1, agents: 1, events: 1, evidence: 0, memories: 1 });

  const keys = Object.keys(body.state).sort();
  assert.ok(keys.includes('memoryModule') && keys.includes('sessions') && keys.includes('messages'));
  assert.equal(keys.includes('__userId'), false, '内部标记不应出现在导出里');

  const versions = body.state.memoryModule.assertionVersions;
  assert.equal(versions.find(v => v.assertionId === 'keep').content, '记得你喜欢下雨天');
  for (const id of ['gone', 'revoked']) {
    const version = versions.find(v => v.assertionId === id);
    assert.equal(version.content, null, `${id} 的正文必须被抹掉`);
    assert.equal(version.redacted, true);
  }
  assert.equal(body.state.memoryModule.sequence, 7, '非内容字段原样保留');
});

test('redaction is a no-op when nothing is hidden, and never mutates the input', () => {
  const clean = { assertions: [{ id: 'a', status: 'active' }], assertionVersions: [{ id: 'v', assertionId: 'a', content: 'x' }] };
  assert.equal(redactHiddenMemoryContent(clean), clean);

  const dirty = memoryModuleFixture();
  const snapshot = structuredClone(dirty);
  const redacted = redactHiddenMemoryContent(dirty);
  assert.notEqual(redacted, dirty);
  assert.deepEqual(dirty, snapshot, '入参不能被改动');
  assert.equal(Object.keys(HIDDEN_MEMORY_STATUSES).length, 6);
});

test('erasure refuses to run without an explicit confirmation', async () => {
  let called = false;
  const { app } = buildApp({ memory: { deleteAccount: async () => { called = true; } } });
  const base = await listen(app);
  const response = await fetch(`${base}/api/account`, { method: 'DELETE' });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'ACCOUNT_ERASE_CONFIRMATION_REQUIRED');
  assert.equal(called, false, '没确认就绝不能碰记忆模块');
});

test('erasure records memory governance and physically removes account rows', async () => {
  const memoryReceipt = { deletionOperationId: 'op-1', status: 'completed', redactionEpoch: 3 };
  let forgetCalled = false;
  const { app, deleted } = buildApp({
    memory: { deleteAccount: async () => memoryReceipt, forgetAccount: async () => { forgetCalled = true; return {}; } }
  });
  const base = await listen(app);
  const logs = collectLogs();
  let body;
  try {
    body = await (await fetch(`${base}/api/account?confirm=erase`, { method: 'DELETE' })).json();
  } finally { logs.restore(); }

  assert.equal(body.ok, true);
  assert.equal(body.userId, USER_ID);
  assert.equal(body.mode, 'delete');
  assert.deepEqual(body.memory, { ok: true, mode: 'delete', deletionOperationId: 'op-1', status: 'completed', redactionEpoch: 3, code: null });
  assert.deepEqual(deleted, [USER_ID]);
  assert.equal(forgetCalled, false);
  assert.ok(logs.lines.some(line => line.includes('"event":"account_erased"')), '必须留下审计记录');
});

test('mode=forget uses the governance "hide + tombstone" path instead of a physical delete', async () => {
  let deleteCalled = false;
  const { app, deleted } = buildApp({
    memory: { forgetAccount: async () => ({ deletionOperationId: 'op-2', status: 'completed', redactionEpoch: 4 }), deleteAccount: async () => { deleteCalled = true; return {}; } }
  });
  const base = await listen(app);
  const logs = collectLogs();
  let body;
  try {
    body = await (await fetch(`${base}/api/account?confirm=erase&mode=forget`, { method: 'DELETE' })).json();
  } finally { logs.restore(); }

  assert.equal(body.mode, 'forget');
  assert.equal(body.memory.deletionOperationId, 'op-2');
  assert.equal(deleteCalled, false);
  assert.deepEqual(deleted, [USER_ID]);
});

test('a storage that cannot erase accounts is reported as a conflict', async () => {
  const blocker = Object.assign(new Error('Account erasure requires STORAGE_PROVIDER=postgres'), { code: 'ACCOUNT_ERASURE_UNSUPPORTED' });
  const { app } = buildApp({ memory: { deleteAccount: async () => ({}) }, deleteUserState: async () => { throw blocker; } });
  const base = await listen(app);
  const logs = collectLogs();
  let response, body;
  try {
    response = await fetch(`${base}/api/account?confirm=erase`, { method: 'DELETE' });
    body = await response.json();
  } finally { logs.restore(); }

  assert.equal(response.status, 409);
  assert.equal(body.error.code, 'ACCOUNT_ERASURE_UNSUPPORTED');
});

test('a failing governance record never blocks the actual erasure', async () => {
  const { app, deleted } = buildApp({
    memory: { deleteAccount: async () => { throw Object.assign(new Error('memory module unavailable'), { code: 'MEMORY_MODULE_UNAVAILABLE' }); } }
  });
  const base = await listen(app);
  const logs = collectLogs();
  let body;
  try {
    body = await (await fetch(`${base}/api/account?confirm=erase`, { method: 'DELETE' })).json();
  } finally { logs.restore(); }

  assert.equal(body.ok, true, '擦除必须成功');
  assert.equal(body.memory.ok, false);
  assert.equal(body.memory.code, 'MEMORY_MODULE_UNAVAILABLE');
  assert.deepEqual(deleted, [USER_ID], '治理记录失败也要照样删数据');
  assert.ok(logs.lines.some(line => line.includes('"event":"account_erase_memory_failed"')));
});
