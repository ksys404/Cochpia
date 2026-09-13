import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createChatRuntime } from './runtime/chat-runtime.js';
import { createRunRegistry } from './runtime/runs.js';
import { buildRuntimeContext, findRegenerationTarget } from './runtime-context.js';
import { routeMessage } from './dynamic-alpha-router.js';
import { executeTool, findTool, getToolRisk, toOpenAITools } from './tools.js';
import { createSseEvent, formatSseEvent } from './sse.js';

// 与 index.js 中的 send/fail 保持一致(这里不能 import index.js,否则会真的启动服务)。
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const send = (res, event, data, run) => {
  if (!run) return false;
  const entry = createSseEvent(run, event, data);
  const target = run.response || res;
  if (!target || target.writableEnded || target.destroyed) return false;
  target.write(formatSseEvent(entry));
  return true;
};

const SESSION_ID = 'session-fixture';

const buildApp = ({ model, chatMemory, runTimeoutMs = 300, prepareTimeoutMs = 300, graceMs = 200 }) => {
  const state = {
    sessions: [{ id: SESSION_ID, kind: 'private', agentId: null, mode: 'companion', companionIntent: 'listen', modelProvider: 'fake', modelName: 'fake', persona: '', title: 'fixture' }],
    messages: { [SESSION_ID]: [] },
    profile: { name: '测试' },
    mode: 'companion',
    agents: []
  };
  const activeRuns = new Map();
  const streamRuns = new Map();
  const { finishRun, attachStreamResponse } = createRunRegistry({ activeRuns, streamRuns, send, streamRetentionMs: 50 });
  const runtime = createChatRuntime({
    state,
    saveState: async () => {},
    getSession: id => state.sessions.find(session => session.id === id),
    touchSession: () => {},
    currentUserId: () => 'local-user',
    runtimeKey: id => `local-user:${id}`,
    agents: { get: id => state.agents.find(agent => agent.id === id) || null },
    agentAvatar: () => '',
    createModelProvider: () => model,
    resolveModelSelection: () => ({ ok: true, config: { provider: 'fake', model: 'fake' } }),
    buildRuntimeContext,
    findRegenerationTarget,
    routeMessage,
    recordDynamicAlphaObservation: () => {},
    chatMemoryForRequest: () => chatMemory,
    shouldRemember: () => false,
    maybeCompactConversation: async () => ({ summary: '', changed: false }),
    executeTool,
    findTool,
    getToolRisk,
    toOpenAITools,
    innerContinuity: { snapshot: () => null, applyPatch: async () => ({ items: [] }) },
    wakeEngine: { reconcileAll: async () => null, kick: async () => null },
    createPiClient: () => ({}),
    agentTasks: { create: async () => ({}) },
    taskScheduler: {},
    send,
    fail,
    activeRuns,
    streamRuns,
    attachStreamResponse,
    finishRun,
    chatRunTimeoutMs: runTimeoutMs,
    chatPrepareTimeoutMs: prepareTimeoutMs,
    chatTerminationGraceMs: graceMs,
    waitForApproval: async () => ({ approved: false }),
    randomUUID
  });

  const app = express();
  app.use(express.json());
  app.post('/api/chat/stream', (req, res) => runtime.handleChatStream(req, res));
  app.post('/api/chat/group', (req, res) => runtime.handleGroupChat(req, res));
  return { app, activeRuns, state };
};

const servers = [];
const listen = app => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => {
    servers.push(server);
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});

after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
});

const memoryOk = { recordTurn: async () => ({ id: 'event' }), retrieve: async () => ({ recalled: [], bundle: null }) };

test('preparation hangs → 503 instead of a silently hanging request', async () => {
  // Memory Module 写库永不返回:SSE 还没建立,旧实现下客户端会一直等下去。
  const { app } = buildApp({ model: { provider: 'fake', model: 'fake', async *stream() { yield 'x'; } }, chatMemory: { recordTurn: () => new Promise(() => {}), retrieve: async () => ({ recalled: [], bundle: null }) }, prepareTimeoutMs: 300 });
  const base = await listen(app);

  const response = await fetch(`${base}/api/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, message: 'hello' })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'CHAT_PREPARE_TIMEOUT');
});

test('run timeout ends the SSE even when the model ignores the abort signal', async () => {
  const stuck = { provider: 'fake', model: 'fake', async *stream() { await new Promise(() => {}); } };
  const { app, activeRuns } = buildApp({ model: stuck, chatMemory: memoryOk, runTimeoutMs: 300, graceMs: 200 });
  const base = await listen(app);

  const response = await fetch(`${base}/api/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, message: 'hello' })
  });
  assert.equal(response.status, 200);
  const text = await response.text();

  assert.match(text, /event: error/);
  assert.match(text, /CHAT_RUN_TIMEOUT/);
  assert.match(text, /event: done/);
  assert.equal(activeRuns.size, 0, 'the run must be released so the session is not stuck in CHAT_ALREADY_RUNNING');
});

test('a healthy turn still streams and finishes normally', async () => {
  const { app, activeRuns } = buildApp({ model: { provider: 'fake', model: 'fake', async *stream() { yield '你'; yield '好'; } }, chatMemory: memoryOk });
  const base = await listen(app);

  const response = await fetch(`${base}/api/chat/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: SESSION_ID, message: 'hello' })
  });
  assert.equal(response.status, 200);
  const text = await response.text();

  assert.match(text, /event: text/);
  assert.match(text, /"delta":"你"/);
  assert.match(text, /"delta":"好"/);
  assert.match(text, /event: done/);
  assert.doesNotMatch(text, /event: error/);
  assert.equal(activeRuns.size, 0);
});
