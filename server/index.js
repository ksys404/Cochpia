import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getStorageStatus, loadState, loadUserState, saveState, storageProvider } from './store.js';
import { createMemoryService } from './memory-service.js';
import { createMemoryGateway } from './memory-gateway.js';
import { createModelProvider, listModelProviders, resolveModelConfig, resolveModelSelection } from './model-provider.js';
import { authenticateRequest, authMode, validateAuthStorage } from './auth.js';
import { buildRuntimeContext, findRegenerationTarget } from './runtime-context.js';
import { createSseEvent, formatSseEvent, replaySseEvents } from './sse.js';
import { applyPersonalityChange, createPersonalityRollbackAudit } from './personality.js';
import { queryCollection } from './collection-query.js';
import { createTaskService, statuses as taskStatuses } from './task-service.js';
import { createEventService } from './event-service.js';
import { createAgentService } from './agent-service.js';
import { collectSyncChanges } from './sync-service.js';
import { createObservability } from './observability.js';
import { createMusicService } from './music-service.js';
import { createNeteaseMusicAdapter } from './netease-music-adapter.js';
import { executeTool, findTool, toOpenAITools } from './tools.js';
import { createPiClient } from './pi-client.js';
import { maybeCompactConversation } from './compaction.js';
import { mergeState } from './state-merge.js';
import { analyzeMessage, shouldRemember } from './auto-memory.js';
import { ensurePsychologyTraits, listAtmospherePresets, resolveAtmosphere } from './psychology.js';
import { sanitizeWorkspacePreferences } from './workspace-preferences.js';

const app = express();
const observability = createObservability({ rateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 120) });
const port = Number(process.env.PORT || 8787);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = clientOrigin.split(',').map(origin => origin.trim()).filter(Boolean);
const isPrivateDevelopmentOrigin = origin => {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.port !== '5173') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    const octets = hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  } catch {
    return false;
  }
};
const requestContext = new AsyncLocalStorage();
let baseState;
try {
  baseState = await loadState();
} catch (error) {
  console.error(JSON.stringify({ event: 'cochpia_startup_failed', code: error.code || 'STORAGE_STARTUP_FAILED', message: error.message }));
  throw error;
}
if (process.env.NODE_ENV === 'production' && (process.env.MODEL_PROVIDER || 'mock') === 'mock') throw new Error('MODEL_PROVIDER=mock is not allowed in production');
if (authMode() === 'required' && !process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required when AUTH_MODE=required');
validateAuthStorage(storageProvider);
if (process.env.NODE_ENV === 'production' && process.env.MEMORY_MODE === 'mcp' && !process.env.MEMORY_MCP_URL) throw new Error('MEMORY_MCP_URL is required when MEMORY_MODE=mcp in production');
const state = new Proxy(baseState, {
  get(target, property) {
    const current = requestContext.getStore()?.state || target;
    if (property === '__userId') return requestContext.getStore()?.user?.id || null;
    return current[property];
  },
  set(target, property, value) {
    const current = requestContext.getStore()?.state || target;
    current[property] = value;
    return true;
  },
  ownKeys(target) { return Reflect.ownKeys(requestContext.getStore()?.state || target); },
  getOwnPropertyDescriptor(target, property) { return { configurable: true, enumerable: true, value: (requestContext.getStore()?.state || target)[property], writable: true }; }
});
const memory = createMemoryGateway(createMemoryService(state, () => saveState(state)), {
  mode: process.env.MEMORY_MODE || 'local',
  url: process.env.MEMORY_MCP_URL,
  token: process.env.MEMORY_MCP_TOKEN,
  timeoutMs: Number(process.env.MEMORY_MCP_TIMEOUT_MS || 5000),
  retryAttempts: Number(process.env.MEMORY_MCP_RETRY_ATTEMPTS || 1),
  userId: () => requestContext.getStore()?.user?.id || 'local-user'
});
const tasks = createTaskService(state, () => saveState(state));
const events = createEventService(state, () => saveState(state));
const agents = createAgentService(state, () => saveState(state));
const activeRuns = new Map();
const streamRuns = new Map();
// 待确认的写操作：key = `${runId}:${toolCallId}` → resolve({ approved })
const pendingApprovals = new Map();
const waitForApproval = (runId, toolCallId) => new Promise(resolve => { pendingApprovals.set(`${runId}:${toolCallId}`, resolve); });
const streamRetentionMs = Math.max(30_000, Number(process.env.SSE_RUN_RETENTION_MS || 300_000));
const model = createModelProvider();
const music = createMusicService({ adapter: process.env.MUSIC_MODE === 'netease' ? createNeteaseMusicAdapter() : undefined });
const defaultModelSelection = () => {
  const provider = process.env.MODEL_PROVIDER || 'mock';
  const config = resolveModelConfig(provider);
  return { modelProvider: provider, modelName: config.model || config.suggestedModels?.[0] || 'mock' };
};
for (const session of state.sessions) {
  if (!session.modelProvider || !session.modelName) Object.assign(session, defaultModelSelection());
}
state.personalityHistory ||= [{ version: state.personality.version, traits: structuredClone(state.personality.traits), summary: state.personality.summary, updatedAt: state.personality.updatedAt }];
state.personalityAudit ||= [];
state.tasks ||= [];
state.events ||= [];
state.agents ||= [];
state.profile ||= { name: 'Cochpia', gender: 'none', age: null, avatar: '✦' };
state.mode ||= 'companion';
for (const session of state.sessions) {
  session.mode ||= state.mode;
  session.companionIntent ||= 'listen';
}
ensurePsychologyTraits(state.personality);

app.use((req, res, next) => {
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || isPrivateDevelopmentOrigin(origin)) return callback(null, true);
      if (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`) return callback(null, true);
      return callback(Object.assign(new Error('CORS origin is not allowed'), { code: 'CORS_ORIGIN_NOT_ALLOWED' }));
    }
  })(req, res, next);
});
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  res.set('Content-Security-Policy', process.env.CSP || "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(observability.middleware);
app.use(async (req, res, next) => {
  const isApi = req.path.startsWith('/api/') || req.path === '/mcp';
  const isPublic = req.path === '/api/health' || req.path === '/api/ready' || req.path === '/api/version' || req.path === '/api/metrics' || req.path === '/api/models';
  if (!isApi || isPublic || authMode() === 'off') {
    if (authMode() === 'off' && isApi) return requestContext.run({ user: { id: 'local-user', local: true }, state: baseState }, next);
    return next();
  }
  try {
    const user = await authenticateRequest(req);
    const userState = await loadUserState(user.id, baseState);
    return requestContext.run({ user, state: userState }, next);
  } catch (error) { return next(error); }
});

const send = (res, event, data, run) => {
  if (!run) return false;
  const entry = createSseEvent(run, event, data);
  const target = run.response || res;
  if (!target || target.writableEnded || target.destroyed) return false;
  target.write(formatSseEvent(entry));
  return true;
};
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const getSession = id => state.sessions.find(session => session.id === id);
const getMessage = (sessionId, messageId) => state.messages[sessionId]?.find(message => message.id === messageId);
const touchSession = session => { if (session) session.updatedAt = new Date().toISOString(); };
const runtimeKey = sessionId => `${requestContext.getStore()?.user?.id || 'local-user'}:${sessionId}`;
const currentUserId = () => requestContext.getStore()?.user?.id || 'local-user';
const finishRun = run => {
  if (run.finished) return;
  run.finished = true;
  if (activeRuns.get(run.key) === run) activeRuns.delete(run.key);
  if (run.heartbeat) clearInterval(run.heartbeat);
  setTimeout(() => { if (streamRuns.get(run.id) === run) streamRuns.delete(run.id); }, streamRetentionMs).unref?.();
};
const attachStreamResponse = (run, res, afterId = '') => {
  run.response = res;
  run.connected = true;
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  for (const entry of replaySseEvents(run.events, afterId)) {
    if (!res.writableEnded && !res.destroyed) res.write(formatSseEvent(entry));
  }
  const heartbeat = setInterval(() => {
    if (run.finished || run.response !== res) return clearInterval(heartbeat);
    send(res, 'heartbeat', { runId: run.id, at: new Date().toISOString() }, run);
  }, 15_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (run.response === res) { run.response = null; run.connected = false; }
  });
};

app.get('/api/health', (_, res) => {
  const storage = getStorageStatus();
  const ok = storage.ready && model.ready;
  res.status(ok ? 200 : 503).json({ ok, status: ok ? 'ready' : 'degraded', service: 'cochpia', storageProvider, storageReady: storage.ready, databaseLatencyMs: storage.lastLatencyMs, lastStorageError: storage.lastError, modelProvider: model.provider, modelName: model.model, modelReady: model.ready, modelProtocol: model.protocol });
});
app.get('/api/ready', (_, res) => {
  const storage = getStorageStatus();
  const ready = storage.ready && model.ready;
  res.status(ready ? 200 : 503).json({ ready, storageReady: storage.ready, modelReady: model.ready });
});
app.get('/api/version', (_, res) => res.json({ service: 'cochpia', version: process.env.APP_VERSION || '0.1.0', node: process.version, environment: process.env.NODE_ENV || 'development' }));
app.get('/api/metrics', (_, res) => res.json(observability.getMetrics()));
app.get('/api/models', (_, res) => res.json({ defaultProvider: process.env.MODEL_PROVIDER || 'mock', providers: listModelProviders() }));
app.get('/api/music/environment', async (_, res) => res.json(await music.environment()));
app.get('/api/music/status', async (_, res) => res.json(await music.status()));
app.get('/api/music/context', async (_, res) => res.json(await music.listeningContext()));
app.get('/api/music/search', async (req, res) => { try { res.json({ items: await music.search(req.query.q) }); } catch (error) { fail(res, error.code === 'INVALID_MUSIC_QUERY' ? 400 : 503, error.code || 'MUSIC_SEARCH_FAILED', error.message); } });
app.post('/api/music/play', async (req, res) => { try { res.json(await music.play(req.body?.track)); } catch (error) { fail(res, 503, error.code || 'MUSIC_PLAY_FAILED', error.message); } });
app.post('/api/music/pause', async (_, res) => { try { res.json(await music.pause()); } catch (error) { fail(res, 503, error.code || 'MUSIC_PAUSE_FAILED', error.message); } });
app.post('/api/music/resume', async (_, res) => { try { res.json(await music.resume()); } catch (error) { fail(res, 503, error.code || 'MUSIC_RESUME_FAILED', error.message); } });
app.post('/api/music/next', async (_, res) => { try { res.json(await music.next()); } catch (error) { fail(res, 503, error.code || 'MUSIC_NEXT_FAILED', error.message); } });
app.post('/api/music/stop', async (_, res) => { try { res.json(await music.stop()); } catch (error) { fail(res, 503, error.code || 'MUSIC_STOP_FAILED', error.message); } });
app.get('/api/sessions', (req, res) => {
  if (req.query.paginated !== 'true' && !req.query.search && req.query.archived === undefined) return res.json(state.sessions);
  const result = queryCollection(state.sessions, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, filter: session => req.query.archived === 'true' ? session.archived === true : req.query.archived === 'false' ? session.archived !== true : true });
  const items = result.items.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(req.query.paginated === 'true' ? { ...result, items } : items);
});
app.post('/api/sessions', async (req, res) => {
  const session = { id: randomUUID(), title: String(req.body?.title || '新的相遇').slice(0, 80), description: String(req.body?.description || '').trim().slice(0, 300), kind: req.body?.kind === 'group' ? 'group' : 'private', agentIds: Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String).slice(0, 20) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: 'companion', companionIntent: 'listen', ...defaultModelSelection() };
  state.sessions.unshift(session); state.messages[session.id] = []; await saveState(state); res.status(201).json(session);
});
app.patch('/api/sessions/:id', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  if (req.body?.title !== undefined) session.title = String(req.body.title).trim().slice(0, 80) || session.title;
  if (req.body?.description !== undefined) session.description = String(req.body.description).trim().slice(0, 300);
  if (Array.isArray(req.body?.agentIds) && session.kind === 'group') session.agentIds = [...new Set(req.body.agentIds.map(String))].slice(0, 20);
  touchSession(session); await saveState(state); res.json(session);
});
app.get('/api/sessions/:id/model', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const selection = { modelProvider: session.modelProvider, modelName: session.modelName };
  const status = resolveModelSelection(selection.modelProvider, selection.modelName);
  res.json({ ...selection, ready: status.ok, error: status.ok ? null : status.error });
});
app.patch('/api/sessions/:id/model', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const provider = String(req.body?.provider || '').trim();
  const requestedModel = String(req.body?.model || '').trim();
  const selection = resolveModelSelection(provider, requestedModel);
  if (!selection.ok) return fail(res, selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400, selection.code, selection.error);
  session.modelProvider = selection.config.provider;
  session.modelName = selection.config.model;
  touchSession(session); await saveState(state);
  res.json({ modelProvider: session.modelProvider, modelName: session.modelName, ready: true });
});
app.get('/api/sessions/:id/persona', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  res.json({ persona: session.persona || '' });
});
app.patch('/api/sessions/:id/persona', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  session.persona = String(req.body?.persona ?? '').trim().slice(0, 2000);
  touchSession(session); await saveState(state);
  res.json({ persona: session.persona });
});
app.get('/api/psychology/presets', (_, res) => res.json(listAtmospherePresets()));
app.get('/api/sessions/:id/atmosphere', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  res.json({ atmosphere: session.atmosphere || '' });
});
app.patch('/api/sessions/:id/atmosphere', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const presetId = String(req.body?.atmosphere ?? '').trim().slice(0, 60);
  if (presetId && !resolveAtmosphere(presetId)) return fail(res, 400, 'INVALID_ATMOSPHERE', 'Unknown atmosphere preset');
  session.atmosphere = presetId;
  touchSession(session); await saveState(state);
  res.json({ atmosphere: session.atmosphere });
});
app.get('/api/sessions/:id/messages', (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const channel = req.query.channel ? String(req.query.channel) : '';
  const allMessages = state.messages[req.params.id] || [];
  const scoped = channel ? allMessages.filter(message => (message.channel || '默认') === channel) : allMessages;
  if (req.query.paginated !== 'true' && !req.query.search) return res.json(scoped);
  const result = queryCollection(scoped, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: message => message.content });
  res.json(req.query.paginated === 'true' ? result : result.items);
});
app.get('/api/sessions/:id/channels', (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const counts = new Map();
  for (const message of state.messages[req.params.id] || []) {
    const name = message.channel || '默认';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  res.json([...counts.entries()].map(([name, count]) => ({ name, count })));
});
app.patch('/api/sessions/:id/messages/:messageId', async (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const message = getMessage(req.params.id, req.params.messageId);
  if (!message) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
  const content = String(req.body?.content || '').trim();
  if (!content) return fail(res, 400, 'INVALID_MESSAGE', 'Message content is required');
  message.content = content.slice(0, 8000); message.updatedAt = new Date().toISOString(); touchSession(getSession(req.params.id)); await saveState(state); res.json(message);
});
app.delete('/api/sessions/:id/messages/:messageId', async (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const messages = state.messages[req.params.id] || [];
  const index = messages.findIndex(message => message.id === req.params.messageId);
  if (index === -1) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
  messages.splice(index, 1); touchSession(getSession(req.params.id)); await saveState(state); res.status(204).end();
});
app.patch('/api/sessions/:id', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const hasTitle = req.body?.title !== undefined;
  const title = String(req.body?.title || '').trim();
  if (!hasTitle && req.body?.archived === undefined && req.body?.pinned === undefined) return fail(res, 400, 'INVALID_SESSION_UPDATE', 'Session update is required');
  if (hasTitle && !title) return fail(res, 400, 'INVALID_TITLE', 'Title is required');
  if (hasTitle) session.title = title.slice(0, 80);
  if (req.body?.archived !== undefined) session.archived = Boolean(req.body.archived);
  if (req.body?.pinned !== undefined) session.pinned = Boolean(req.body.pinned);
  touchSession(session); await saveState(state); res.json(session);
});
app.delete('/api/sessions/:id', async (req, res) => {
  const index = state.sessions.findIndex(session => session.id === req.params.id);
  if (index === -1) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  state.sessions.splice(index, 1); delete state.messages[req.params.id]; await saveState(state); res.status(204).end();
});
app.get('/api/tasks', (req, res) => {
  const status = req.query.status ? String(req.query.status) : '';
  if (status && !taskStatuses.has(status)) return fail(res, 400, 'INVALID_TASK_STATUS', 'Invalid task status');
  const items = tasks.list({ status, sessionId: req.query.sessionId, overdue: req.query.overdue === 'true', search: req.query.search, limit: 100 });
  const result = queryCollection(items, { search: '', limit: req.query.limit, offset: req.query.offset, text: item => `${item.title} ${item.description}` });
  return res.json(req.query.paginated === 'true' ? result : result.items);
});
app.post('/api/tasks', async (req, res) => {
  try {
    const sessionId = req.body?.sessionId;
    if (sessionId && !getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    res.status(201).json(await tasks.create(req.body || {}));
  } catch (error) { fail(res, 400, 'INVALID_TASK', error.message); }
});
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    if (req.body?.sessionId && !getSession(req.body.sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const task = await tasks.update(req.params.id, req.body || {});
    task ? res.json(task) : fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
  } catch (error) { fail(res, 400, 'INVALID_TASK', error.message); }
});
app.delete('/api/tasks/:id', async (req, res) => {
  const removed = await tasks.remove(req.params.id);
  removed ? res.status(204).end() : fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
});
app.get('/api/events', (req, res) => {
  const type = req.query.type ? String(req.query.type) : '';
  if (type && !['anniversary', 'birthday', 'plan', 'record'].includes(type)) return fail(res, 400, 'INVALID_EVENT_TYPE', 'Invalid event type');
  res.json(events.list({ type, upcomingDays: req.query.upcomingDays ? Number(req.query.upcomingDays) : undefined }));
});
app.post('/api/events', async (req, res) => { try { res.status(201).json(await events.create(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_EVENT', error.message); } });
app.patch('/api/events/:id', async (req, res) => { try { const event = await events.update(req.params.id, req.body || {}); event ? res.json(event) : fail(res, 404, 'EVENT_NOT_FOUND', 'Event not found'); } catch (error) { fail(res, 400, 'INVALID_EVENT', error.message); } });
app.delete('/api/events/:id', async (req, res) => { const removed = await events.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'EVENT_NOT_FOUND', 'Event not found'); });
app.get('/api/agents', (_, res) => res.json(agents.list()));
app.post('/api/agents', async (req, res) => { try { res.status(201).json(await agents.create(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
app.patch('/api/agents/:id', async (req, res) => { try { const agent = await agents.update(req.params.id, req.body || {}); agent ? res.json(agent) : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
app.delete('/api/agents/:id', async (req, res) => { const removed = await agents.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); });
app.get('/api/sync', (req, res) => {
  try { return res.json({ version: 1, syncedAt: new Date().toISOString(), ...collectSyncChanges(state, { cursor: req.query.cursor, limit: req.query.limit }) }); }
  catch (error) { return fail(res, 400, 'INVALID_SYNC_CURSOR', error.message); }
});
app.get('/api/memories', async (req, res) => {
  const memories = await memory.list(req.query.paginated === 'true' ? { ...req.query, limit: 100 } : req.query);
  if (req.query.paginated !== 'true') return res.json(memories);
  const result = queryCollection(memories, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: item => `${item.summary} ${item.type} ${item.source}` });
  return res.json(result);
});
app.post('/api/memories', async (req, res) => { try { res.status(201).json(await memory.hold(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_MEMORY', error.message); } });
app.get('/api/memories/export', async (_, res) => {
  const memories = await memory.exportMemories();
  res.set('Content-Disposition', 'attachment; filename="cochpia-memories.json"');
  res.json({ exportedAt: new Date().toISOString(), version: 1, memories });
});
app.get('/api/export', (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="cochpia-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    version: 1,
    state: {
      sessions: state.sessions,
      messages: state.messages,
      memories: state.memories,
      personality: state.personality,
      evidence: state.evidence,
      tasks: state.tasks,
      personalityHistory: state.personalityHistory,
      personalityAudit: state.personalityAudit,
      agents: state.agents,
      profile: state.profile,
      workspacePreferences: state.workspacePreferences || null
    }
  });
});
app.post('/api/import', async (req, res) => {
  try {
    const incoming = req.body?.state;
    if (!incoming || typeof incoming !== 'object') return fail(res, 400, 'INVALID_IMPORT', 'Import state is required');
    const merged = mergeState(state, incoming);
    Object.assign(state, merged);
    await saveState(state);
    res.json({ ok: true, importedAt: new Date().toISOString() });
  } catch (error) {
    fail(res, 400, 'IMPORT_FAILED', error.message);
  }
});
app.get('/api/preferences', (_, res) => res.json({ preferences: state.workspacePreferences || null, updatedAt: state.workspacePreferencesUpdatedAt || null }));
app.patch('/api/preferences', async (req, res) => {
  try {
    const preferences = sanitizeWorkspacePreferences(req.body?.preferences);
    state.workspacePreferences = preferences;
    state.workspacePreferencesUpdatedAt = new Date().toISOString();
    await saveState(state);
    return res.json({ preferences, updatedAt: state.workspacePreferencesUpdatedAt });
  } catch (error) {
    return fail(res, 400, 'INVALID_PREFERENCES', error.message);
  }
});
app.post('/api/memories/batch', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String).filter(Boolean))] : [];
  if (!ids.length) return fail(res, 400, 'INVALID_MEMORY_BATCH', 'At least one memory id is required');
  if (req.body?.action !== 'revoke') return fail(res, 400, 'INVALID_MEMORY_BATCH_ACTION', 'Only revoke is supported');
  const results = await Promise.all(ids.map(id => memory.revoke(id)));
  res.json({ requested: ids.length, revoked: results.filter(Boolean).length, memories: results.filter(Boolean) });
});
app.post('/api/memories/:id/revoke', async (req, res) => { const item = await memory.revoke(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.get('/api/memories/:id', async (req, res) => { const item = await memory.get(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.patch('/api/memories/:id', async (req, res) => { try { const item = await memory.update(req.params.id, req.body || {}); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); } catch (error) { fail(res, 400, 'INVALID_MEMORY', error.message); } });
app.delete('/api/memories/:id', async (req, res) => { const removed = await memory.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.get('/api/memory/overview', async (_, res) => { const memories = await memory.list({ limit: 100 }); res.json({ count: memories.length, memories: memories.slice(0, 8) }); });
app.post('/api/models/:provider/test', async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const requestedModel = String(req.body?.model || '').trim();
  const selection = resolveModelSelection(provider, requestedModel);
  if (!selection.ok) return fail(res, selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400, selection.code, selection.error);
  const selected = createModelProvider(provider, { model: selection.config.model });
  const startedAt = Date.now();
  try {
    await selected.generate({ message: 'Connection test. Reply with OK.', recalled: [] });
    res.json({ ok: true, provider: selected.provider, model: selected.model, protocol: selected.protocol, latencyMs: Date.now() - startedAt });
  } catch (error) {
    fail(res, error.code === 'MODEL_AUTH_FAILED' ? 401 : error.code === 'MODEL_INSUFFICIENT_BALANCE' ? 402 : error.code === 'MODEL_NOT_FOUND' ? 404 : error.code === 'MODEL_TIMEOUT' ? 504 : 502, error.code || 'MODEL_CONNECTION_FAILED', error.message);
  }
});
app.post('/api/chat/cancel', (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  const run = activeRuns.get(runtimeKey(sessionId));
  if (!run) return fail(res, 404, 'CHAT_RUN_NOT_FOUND', 'No active chat run was found');
  run.cancelled = true;
  run.controller.abort();
  if (!run.cancelNotified) {
    run.cancelNotified = true;
    send(run.response, 'error', { code: 'CHAT_CANCELLED', message: 'Chat generation was cancelled' }, run);
    send(run.response, 'done', { ok: false, cancelled: true, runId: run.id }, run);
    finishRun(run);
  }
  res.status(202).json({ ok: true, sessionId });
});
app.get('/api/chat/stream/:runId', (req, res) => {
  const run = streamRuns.get(req.params.runId);
  if (!run || run.userId !== currentUserId()) return fail(res, 404, 'STREAM_RUN_NOT_FOUND', 'Stream run not found');
  if (run.response && !run.response.writableEnded && !run.response.destroyed) run.response.end();
  attachStreamResponse(run, res, req.get('last-event-id') || req.query.afterEventId || '');
  if (run.finished) res.end();
});
app.get('/api/memory/dream', async (req, res) => res.json({ memories: await memory.dream(req.query.limit), generatedAt: new Date().toISOString() }));
app.get('/api/profile', (_, res) => res.json(state.profile));
app.patch('/api/profile', async (req, res) => {
  try {
    const input = req.body || {};
    if (input.name !== undefined) {
      const name = String(input.name).trim().slice(0, 20);
      if (!name) return fail(res, 400, 'INVALID_NAME', 'Name is required');
      state.profile.name = name;
    }
    if (input.gender !== undefined) {
      const gender = String(input.gender);
      if (!['none', 'male', 'female', 'other'].includes(gender)) return fail(res, 400, 'INVALID_GENDER', 'Invalid gender');
      state.profile.gender = gender;
    }
    if (input.age !== undefined) {
      if (input.age === null) state.profile.age = null;
      else {
        const age = Number(input.age);
        if (!Number.isFinite(age) || age < 0 || age > 90) return fail(res, 400, 'INVALID_AGE', 'Age must be between 0 and 90');
        state.profile.age = age;
      }
    }
    if (input.avatar !== undefined) state.profile.avatar = String(input.avatar).slice(0, 8) || '✦';
    if (input.avatarImage !== undefined) {
      const avatarImage = String(input.avatarImage || '');
      if (avatarImage && !avatarImage.startsWith('data:image/')) return fail(res, 400, 'INVALID_AVATAR_IMAGE', 'Avatar image must be a data URL');
      if (avatarImage.length > 400000) return fail(res, 400, 'AVATAR_IMAGE_TOO_LARGE', 'Avatar image is too large');
      state.profile.avatarImage = avatarImage || null;
    }
    if (input.characterSheet !== undefined) {
      const characterSheet = String(input.characterSheet || '');
      if (characterSheet && !characterSheet.startsWith('data:image/')) return fail(res, 400, 'INVALID_CHARACTER_SHEET', 'Character sheet must be a data URL');
      if (characterSheet.length > 2000000) return fail(res, 400, 'CHARACTER_SHEET_TOO_LARGE', 'Character sheet is too large');
      state.profile.characterSheet = characterSheet || null;
    }
    if (input.characterAnimation !== undefined) {
      if (input.characterAnimation === null) state.profile.characterAnimation = null;
      else {
        const animation = input.characterAnimation;
        if (typeof animation !== 'object' || !Number.isFinite(Number(animation.frameWidth)) || !Number.isFinite(Number(animation.frameHeight))) {
          return fail(res, 400, 'INVALID_CHARACTER_ANIMATION', 'Character animation is invalid');
        }
        state.profile.characterAnimation = animation;
      }
    }
    state.profile.updatedAt = new Date().toISOString();
    await saveState(state);
    return res.json(state.profile);
  } catch (error) { return fail(res, 400, 'INVALID_PROFILE', error.message); }
});
app.get('/api/mode', (req, res) => {
  const session = req.query.sessionId ? getSession(String(req.query.sessionId)) : null;
  res.json({ mode: session?.mode || state.mode, companionIntent: session?.companionIntent || 'listen', sessionId: session?.id || null });
});
app.patch('/api/mode', async (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['companion', 'work'].includes(mode)) return fail(res, 400, 'INVALID_MODE', 'Mode must be companion or work');
  const session = req.body?.sessionId ? getSession(String(req.body.sessionId)) : null;
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  session.mode = mode;
  if (req.body?.companionIntent && ['listen', 'comfort', 'advice', 'accompany', 'quiet'].includes(req.body.companionIntent)) session.companionIntent = req.body.companionIntent;
  touchSession(session);
  await saveState(state);
  res.json({ mode: session.mode, companionIntent: session.companionIntent || 'listen', sessionId: session.id });
});
app.post('/api/chat/approve', (req, res) => {
  const { runId, toolCallId, approved } = req.body || {};
  const key = `${runId}:${toolCallId}`;
  const resolve = pendingApprovals.get(key);
  if (!resolve) return fail(res, 404, 'NO_PENDING_APPROVAL', 'No pending approval');
  pendingApprovals.delete(key);
  resolve({ approved: approved === true });
  res.json({ ok: true });
});
// 文件上传：手机/网页上传文件到服务端，供工作模式 read 工具处理
app.post('/api/upload', async (req, res) => {
  try {
    const { name, dataUrl } = req.body || {};
    const fileName = String(name || 'file').replace(/[^\w.\-\u4e00-\u9fff]/g, '_').slice(0, 100) || 'file';
    if (!dataUrl || typeof dataUrl !== 'string') return fail(res, 400, 'INVALID_UPLOAD', 'dataUrl is required');
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return fail(res, 400, 'INVALID_UPLOAD', 'Invalid data URL');
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 5 * 1024 * 1024) return fail(res, 400, 'FILE_TOO_LARGE', '文件过大（最大 5MB）');
    const uploadDir = path.join(process.cwd(), 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, fileName), buffer);
    return res.json({ name: fileName, path: `uploads/${fileName}`, size: buffer.length });
  } catch (error) { return fail(res, 400, 'UPLOAD_FAILED', error.message); }
});
app.get('/api/personality', (_, res) => res.json({ ...state.personality, evidenceCount: state.evidence.length }));
app.get('/api/personality/history', (_, res) => res.json(state.personalityHistory.map(version => ({
  version: version.version,
  traits: version.traits,
  summary: version.summary,
  updatedAt: version.updatedAt
}))));
app.get('/api/personality/audit', (_, res) => res.json(state.personalityAudit || []));
app.get('/api/growth/evidence', (req, res) => {
  const status = req.query.status ? String(req.query.status) : '';
  if (status && !['draft', 'confirmed', 'rejected'].includes(status)) return fail(res, 400, 'INVALID_EVIDENCE_STATUS', 'Invalid evidence status');
  const result = queryCollection(state.evidence, {
    search: req.query.search,
    limit: req.query.limit,
    offset: req.query.offset,
    filter: item => !status || item.status === status,
    text: item => `${item.claim} ${item.evidence} ${item.type}`
  });
  if (req.query.paginated !== 'true' && !req.query.search && !status) return res.json(state.evidence);
  return res.json(req.query.paginated === 'true' ? result : result.items);
});
app.get('/api/growth/evidence/:id', async (req, res) => { const item = await memory.trace(req.params.id); item ? res.json(item) : fail(res, 404, 'EVIDENCE_NOT_FOUND', 'Evidence not found'); });
const reviewEvidence = async (item, status, previousStatus = item.status) => {
  const updated = await memory.updateEvidence(item.id, status);
  if (status === 'confirmed' && previousStatus !== 'confirmed') {
    const change = applyPersonalityChange(state.personality, state.personalityHistory, { evidenceId: updated.id, proposedChange: updated.proposedChange });
    if (change) {
      state.personality = change.personality;
      state.personalityHistory = change.history;
      state.personalityAudit.unshift({ id: randomUUID(), action: 'growth_confirmed', evidenceId: updated.id, version: state.personality.version, createdAt: new Date().toISOString() });
    }
  }
  return updated;
};
app.patch('/api/growth/evidence/:id', async (req, res) => {
  try {
    const requestedStatus = req.body?.status === 'approved' ? 'confirmed' : req.body?.status;
    const previous = await memory.trace(req.params.id);
    if (!previous) return fail(res, 404, 'EVIDENCE_NOT_FOUND', 'Evidence not found');
    if (!['draft', 'confirmed', 'rejected'].includes(requestedStatus)) return fail(res, 400, 'INVALID_EVIDENCE_STATUS', 'Invalid evidence status');
    const item = await reviewEvidence(previous, requestedStatus, previous.status);
    await saveState(state);
    return res.json(item);
  } catch (error) { return fail(res, 400, 'INVALID_EVIDENCE_STATUS', error.message); }
});
app.post('/api/growth/evidence/batch', async (req, res) => {
  try {
    const requestedStatus = req.body?.status === 'approved' ? 'confirmed' : req.body?.status;
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
    if (!['confirmed', 'rejected'].includes(requestedStatus)) return fail(res, 400, 'INVALID_EVIDENCE_STATUS', 'Batch status must be confirmed or rejected');
    if (!ids.length || ids.length > 100) return fail(res, 400, 'INVALID_EVIDENCE_IDS', 'Batch evidence ids must contain 1 to 100 items');
    const previousItems = ids.map(id => state.evidence.find(item => item.id === id));
    if (previousItems.some(item => !item)) return fail(res, 404, 'EVIDENCE_NOT_FOUND', 'One or more evidence items were not found');
    const items = [];
    let personalityChanges = 0;
    for (const previous of previousItems) {
      const versionBefore = state.personality.version;
      const item = await reviewEvidence(previous, requestedStatus, previous.status);
      if (state.personality.version !== versionBefore) personalityChanges += 1;
      items.push(item);
    }
    await saveState(state);
    return res.json({ requested: ids.length, status: requestedStatus, updated: items.length, personalityChanges, items });
  } catch (error) { return fail(res, 400, 'INVALID_EVIDENCE_STATUS', error.message); }
});
app.post('/api/personality/rollback', async (req, res) => {
  const version = Number(req.body?.version);
  const snapshot = state.personalityHistory.find(item => item.version === version);
  if (!snapshot) return fail(res, 404, 'PERSONALITY_VERSION_NOT_FOUND', 'Personality version not found');
  const fromVersion = state.personality.version;
  state.personality = { version: snapshot.version, traits: structuredClone(snapshot.traits), summary: snapshot.summary, updatedAt: new Date().toISOString() };
  state.personalityAudit.unshift(createPersonalityRollbackAudit({ fromVersion, toVersion: snapshot.version }));
  await saveState(state); res.json({ ...state.personality, audit: state.personalityAudit[0] });
});

const detectModeSwitch = text => {
  const t = String(text || '').trim();
  const wantsWork = /(切换到|进入|开启|切到|回到|切换).{0,4}工作模式/.test(t) || t === '工作模式';
  const wantsCompanion = /(切换到|进入|开启|切到|回到|切换).{0,4}陪伴模式/.test(t) || t === '陪伴模式';
  if (wantsWork) return 'work';
  if (wantsCompanion) return 'companion';
  return null;
};

// 用 Pi RPC 执行工作模式任务：spawn `pi --mode rpc`，把事件流映射为 Cochpia 的 SSE 事件
async function runPiWorkMode({ res, run, userMessage, assistantMessage, sessionId, mode = 'work' }) {
  const pi = createPiClient({ cwd: process.cwd() });
  let fullText = '';
  await pi.prompt(userMessage.content, event => {
    if (run.cancelled) return;
    if (event.type === 'message_update') {
      const e = event.assistantMessageEvent;
      if (e?.type === 'text_delta') { fullText += e.delta; send(res, 'text', { delta: e.delta }, run); }
    } else if (event.type === 'tool_execution_start') {
      send(res, 'tool', { runId: run.id, name: event.toolName, args: event.args }, run);
    } else if (event.type === 'tool_execution_end') {
      const text = (event.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '';
      send(res, 'tool_result', { runId: run.id, name: event.toolName, result: text.slice(0, 4000) }, run);
    }
  });
  assistantMessage.content = fullText || '（Pi 未返回内容）';
  state.messages[sessionId].push(assistantMessage);
  touchSession(getSession(sessionId));
  await saveState(state);
  send(res, 'done', { runId: run.id, messageId: assistantMessage.id, engine: 'pi', mode }, run);
  return true;
}

async function handleChatStream(req, res, { regenerateMessageId = null, retry = false } = {}) {
  const { sessionId, message, provider, model: requestedModel, channel, companionIntent } = req.body || {};
  const activeChannel = String(channel || '默认').slice(0, 60);
  const validCompanionIntents = new Set(['listen', 'comfort', 'advice', 'accompany', 'quiet']);
  if (!sessionId || (!regenerateMessageId && !String(message || '').trim())) return res.status(400).json({ error: 'sessionId and message are required' });
  if (!getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  if (!state.messages[sessionId]) state.messages[sessionId] = [];
  const regeneration = regenerateMessageId ? findRegenerationTarget(state.messages[sessionId], regenerateMessageId) : null;
  if (regenerateMessageId && !regeneration) return fail(res, 404, 'REGENERATE_TARGET_NOT_FOUND', 'Assistant message with a preceding user message was not found');
  const userMessage = regeneration?.user || { id: randomUUID(), role: 'user', content: String(message).trim().slice(0, 8000), createdAt: new Date().toISOString(), channel: activeChannel };
  const session = getSession(sessionId);
  const currentMode = () => session.mode || state.mode || 'companion';
  const activeCompanionIntent = validCompanionIntents.has(companionIntent) ? companionIntent : (session.companionIntent || 'listen');
  if (currentMode() === 'companion' && validCompanionIntents.has(companionIntent) && session.companionIntent !== companionIntent) {
    session.companionIntent = companionIntent;
    touchSession(session);
  }
  const hasRequestSelection = Boolean(provider || requestedModel);
  const requestedProvider = provider || session.modelProvider || process.env.MODEL_PROVIDER || 'mock';
  const requestedName = requestedModel || session.modelName || '';
  const selection = resolveModelSelection(requestedProvider, requestedName);
  if (!selection.ok) return fail(res, selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400, selection.code, selection.error);
  const selectedModel = createModelProvider(requestedProvider, { model: selection.config.model });
  if (hasRequestSelection) {
    session.modelProvider = selection.config.provider;
    session.modelName = selection.config.model;
    touchSession(session);
  }
  if (!regeneration) {
    state.messages[sessionId].push(userMessage);
    try {
      await saveState(state);
    } catch (error) {
      state.messages[sessionId].pop();
      return fail(res, 503, error.code || 'STORAGE_WRITE_FAILED', error.message);
    }
  }
  const recalled = await memory.breath(userMessage.content);
  const response = recalled.length
    ? `我记得我们正在建立一段会持续变化的关系。你刚才提到“${userMessage.content.slice(0, 54)}”，我会把它和过去的经历放在一起理解。现在的我会更关注你的真实感受，也会保留这次相遇。`
    : `我听见了：“${userMessage.content.slice(0, 54)}”。这是我们共同经历的一个新片段。我会先理解它，再决定哪些内容值得长期记住。`;
  const assistantMessage = { id: randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString(), regeneratedFrom: regeneration?.assistant.id || null, channel: activeChannel };
  if (regeneration) {
    regeneration.assistant.supersededAt = new Date().toISOString();
    regeneration.assistant.supersededBy = assistantMessage.id;
  }
  const restoreRegeneration = () => {
    if (regeneration) {
      delete regeneration.assistant.supersededAt;
      delete regeneration.assistant.supersededBy;
    }
  };
  const runKey = runtimeKey(sessionId);
  if (activeRuns.has(runKey)) return fail(res, 409, 'CHAT_ALREADY_RUNNING', 'A chat run is already active for this session');
  const run = { id: randomUUID(), key: runKey, userId: currentUserId(), sessionId, controller: new AbortController(), cancelled: false, finished: false, sequence: 0, events: [], response: null, connected: false };
  activeRuns.set(runKey, run);
  streamRuns.set(run.id, run);
  attachStreamResponse(run, res);
  send(res, 'meta', { runId: run.id, messageId: assistantMessage.id, recalled: recalled.length, protocol: 'cochpia.sse.v1', provider: selectedModel.provider, model: selectedModel.model, regeneratedFrom: regeneration?.assistant.id || null, retry }, run);
  let summary = session.summary || '';
  try {
    const compact = await maybeCompactConversation(session, state.messages[sessionId], selectedModel);
    summary = compact.summary;
    if (compact.changed) await saveState(state);
  } catch (error) {
    console.error(JSON.stringify({ event: 'compaction_failed', code: error.code || 'COMPACTION_FAILED' }));
  }
  // 语言切换工作/陪伴模式
  const switchTo = detectModeSwitch(userMessage.content);
  if (switchTo && switchTo !== currentMode()) {
    session.mode = switchTo;
    touchSession(session);
    await saveState(state);
    assistantMessage.content = switchTo === 'work'
      ? '已切换到「工作模式」。现在我会以任务为导向，帮你执行具体任务。需要切回时，说「切换到陪伴模式」即可。'
      : '已切回「陪伴模式」。我会继续像平常一样陪着你。需要工作时，说「切换到工作模式」即可。';
    state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId));
    send(res, 'text', { delta: assistantMessage.content }, run);
    send(res, 'done', { runId: run.id, messageId: assistantMessage.id, mode: currentMode(), provider: selectedModel.provider, model: selectedModel.model }, run);
    finishRun(run); if (run.response) run.response.end();
    return;
  }
  // 工作模式：优先 Pi RPC（强引擎），失败回退本地工具
  if (currentMode() === 'work') {
    try {
      if (await runPiWorkMode({ res, run, userMessage, assistantMessage, sessionId, mode: currentMode() })) {
        finishRun(run); if (run.response) run.response.end(); return;
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'pi_rpc_unavailable', error: error.code || error.message }));
    }
    try {
      // 工作模式可用独立模型（WORK_MODEL_PROVIDER / WORK_MODEL_NAME），未配置则用会话模型
      const workProviderName = process.env.WORK_MODEL_PROVIDER || requestedProvider;
      const workModelName = process.env.WORK_MODEL_NAME || selection.config.model;
      const workModel = (workProviderName === requestedProvider && workModelName === selection.config.model)
        ? selectedModel
        : createModelProvider(workProviderName, { model: workModelName });
      const rt = buildRuntimeContext({ messages: [], personality: state.personality, recalled, summary, persona: session.persona, upcomingEvents: events.listUpcoming(7), atmosphere: resolveAtmosphere(session.atmosphere)?.tone, profile: state.profile, mode: currentMode(), companionIntent: activeCompanionIntent });
      const system = workModel.composeSystemPrompt({ recalled, runtimeContext: rt });
      const history = state.messages[sessionId].slice(0, -1).slice(-10).map(m => ({ role: m.role, content: m.content }));
      const conversation = [...history, { role: 'user', content: userMessage.content }];
      let finalContent = '';
      for (let step = 0; step < 8; step += 1) {
        if (run.cancelled) { restoreRegeneration(); finishRun(run); return; }
        const result = await workModel.generateWithTools({ system, messages: conversation, tools: toOpenAITools(), signal: run.controller.signal });
        if (!result.toolCalls.length) { finalContent = result.content; break; }
        conversation.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });
        for (const tc of result.toolCalls) {
          const name = tc.function?.name || '';
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
          const tool = findTool(name);
          send(res, 'tool', { runId: run.id, name, args }, run);
          let toolResult;
          if (tool?.requiresApproval) {
            send(res, 'tool_pending', { runId: run.id, toolCallId: tc.id, name, args }, run);
            const approval = await waitForApproval(run.id, tc.id);
            if (!approval.approved) {
              toolResult = '用户拒绝了这次修改';
              send(res, 'tool_result', { runId: run.id, name, result: toolResult }, run);
              conversation.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
              continue;
            }
            toolResult = await executeTool(name, args);
          } else {
            toolResult = await executeTool(name, args);
          }
          send(res, 'tool_result', { runId: run.id, name, result: String(toolResult).slice(0, 4000) }, run);
          conversation.push({ role: 'tool', tool_call_id: tc.id, content: String(toolResult).slice(0, 8000) });
        }
      }
      assistantMessage.content = finalContent || '（工具调用未产生最终回复，请换个问法）';
      state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId));
      send(res, 'text', { delta: assistantMessage.content }, run);
      send(res, 'done', { runId: run.id, messageId: assistantMessage.id, mode: currentMode(), provider: selectedModel.provider, model: selectedModel.model }, run);
      finishRun(run); if (run.response) run.response.end();
    } catch (error) {
      send(res, 'error', { code: error.code || 'WORK_MODE_FAILED', message: error.message }, run);
      send(res, 'done', { ok: false, messageId: assistantMessage.id, runId: run.id }, run);
      restoreRegeneration(); finishRun(run);
      if (run.response) run.response.end();
    }
    return;
  }
  try {
    for await (const delta of selectedModel.stream({
      message: userMessage.content,
      recalled,
      runtimeContext: buildRuntimeContext({ messages: state.messages[sessionId], personality: state.personality, recalled, summary, persona: session.persona, upcomingEvents: events.listUpcoming(7), atmosphere: resolveAtmosphere(session.atmosphere)?.tone, profile: state.profile, mode: currentMode(), companionIntent: activeCompanionIntent }),
      signal: run.controller.signal
    })) {
      if (run.cancelled) { restoreRegeneration(); finishRun(run); return; }
      assistantMessage.content += delta;
      send(res, 'text', { delta }, run);
    }
  }
  catch (error) {
    if (!run.cancelNotified) { send(res, 'error', { code: error.code || 'MODEL_UNAVAILABLE', message: error.message }, run); send(res, 'done', { ok: false, messageId: assistantMessage.id, runId: run.id }, run); if (run.response) run.response.end(); }
    restoreRegeneration();
    finishRun(run);
    return;
  }
  if (run.cancelled) { restoreRegeneration(); finishRun(run); return; }
  let held;
  try {
  state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId));
  if (shouldRemember(userMessage.content)) {
    const emotion = analyzeMessage(userMessage.content);
    held = await memory.hold({ type: 'event', summary: `用户说：${userMessage.content.slice(0, 200)}`, source: `chat:${sessionId}`, valence: emotion.valence, arousal: emotion.arousal, importance: 0.6 });
    await memory.grow({ claim: 'Cochpia 正在学习把共同经历纳入后续回应。', evidence: `本次对话形成事件记忆 ${held.id}`, sourceMessageId: assistantMessage.id, proposedChange: { traitKey: 'warmth', delta: 0.005 } });
  }
  await saveState(state);
  } catch (error) {
    send(res, 'error', { code: 'FINALIZE_FAILED', message: error.message }, run);
    send(res, 'done', { ok: false, messageId: assistantMessage.id, runId: run.id }, run);
    restoreRegeneration();
    finishRun(run);
    if (run.response) return run.response.end();
    return;
  }
  send(res, 'done', { runId: run.id, messageId: assistantMessage.id, memoryId: held?.id || null, personalityVersion: state.personality.version, provider: selectedModel.provider, model: selectedModel.model, regeneratedFrom: regeneration?.assistant.id || null, retry }, run); finishRun(run); if (run.response) run.response.end();
}

app.post('/api/chat/stream', (req, res) => handleChatStream(req, res));
app.post('/api/chat/regenerate', (req, res) => handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null }));
app.post('/api/chat/retry', (req, res) => handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null, retry: true }));
app.post('/api/chat/group', async (req, res) => {
  const { sessionId, message, channel } = req.body || {};
  if (!sessionId || !String(message || '').trim()) return fail(res, 400, 'INVALID_REQUEST', 'sessionId and message are required');
  const session = getSession(sessionId);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const activeChannel = String(channel || '默认').slice(0, 60);
  if (!state.messages[sessionId]) state.messages[sessionId] = [];
  const userMessage = { id: randomUUID(), role: 'user', content: String(message).trim().slice(0, 8000), createdAt: new Date().toISOString(), channel: activeChannel };
  state.messages[sessionId].push(userMessage);
  const agentIds = Array.isArray(session.agentIds) ? session.agentIds : [];
  const replies = [];
  for (const agentId of agentIds) {
    const agent = agents.get(agentId);
    if (!agent) continue;
    let content;
    try {
      const provider = agent.provider || session.modelProvider || process.env.MODEL_PROVIDER || 'mock';
      const modelName = agent.model || session.modelName || '';
      const selection = resolveModelSelection(provider, modelName);
      let model;
      if (selection.ok) {
        model = createModelProvider(provider, { model: selection.config.model });
      } else {
        // Agent 模型无效时回退到会话/默认模型（避免落到 mock）
        const fallbackProvider = session.modelProvider || process.env.MODEL_PROVIDER || 'mock';
        const fallbackSelection = resolveModelSelection(fallbackProvider, session.modelName || '');
        model = fallbackSelection.ok ? createModelProvider(fallbackProvider, { model: fallbackSelection.config.model }) : createModelProvider('mock');
      }
      content = await model.generate({ message: String(message), recalled: [], runtimeContext: buildRuntimeContext({ messages: state.messages[sessionId], personality: state.personality, persona: agent.persona || session.persona, upcomingEvents: events.listUpcoming(7), profile: { ...state.profile, name: agent.name } }) });
    } catch (error) { content = `（${agent.name} 暂时无法回应）`; }
    const reply = { id: randomUUID(), role: 'assistant', content: String(content || '').trim(), createdAt: new Date().toISOString(), channel: activeChannel, senderId: agent.id, senderName: agent.name, senderAvatar: agent.avatar };
    state.messages[sessionId].push(reply);
    replies.push(reply);
  }
  touchSession(session);
  await saveState(state);
  res.json({ messages: replies });
});

app.post('/mcp', async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'cochpia-memory', version: '0.1.0' }, capabilities: { tools: {} } };
    else if (method === 'notifications/initialized') return res.status(202).end();
    else if (method === 'tools/list') result = { tools: memory.listTools().map(name => ({ name, description: `Cochpia memory tool: ${name}` })) };
    else if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (name === 'breath') result = { content: [{ type: 'text', text: JSON.stringify(await memory.breath(args.query, args.limit)) }] };
      else if (name === 'hold') result = { content: [{ type: 'text', text: JSON.stringify(await memory.hold(args)) }] };
      else if (name === 'dream') result = { content: [{ type: 'text', text: JSON.stringify(await memory.dream(args.limit)) }] };
      else if (name === 'grow') result = { content: [{ type: 'text', text: JSON.stringify(await memory.grow(args)) }] };
      else if (name === 'trace') result = { content: [{ type: 'text', text: JSON.stringify(await memory.trace(args.id)) }] };
      else result = { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }], isError: true };
    } else throw new Error(`Unsupported method: ${method}`);
    res.json({ jsonrpc: '2.0', id, result });
  } catch (error) { res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } }); }
});

app.use('/api', (_, res) => fail(res, 404, 'API_ROUTE_NOT_FOUND', 'API route not found'));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const code = error.code || 'INTERNAL_ERROR';
  const status = error.status || (code === 'CORS_ORIGIN_NOT_ALLOWED' ? 403 : (code.startsWith('STORAGE_') || code.startsWith('DATABASE_') ? 503 : 500));
  console.error(JSON.stringify({ event: 'request_error', code, requestId: req.requestId, traceId: req.traceId, method: req.method, path: req.path }));
  return fail(res, status, code, error.message || 'Internal server error');
});

const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
app.use(express.static(clientDist));
app.use((_, res) => res.sendFile(path.join(clientDist, 'index.html')));
app.listen(port, () => console.log(`Cochpia server listening on http://localhost:${port}`));
