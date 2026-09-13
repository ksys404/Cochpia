import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getStorageStatus, loadState, loadUserState, saveState, storageProvider } from './store.js'; import { createMemoryModuleRuntime } from './memory-module-runtime.js'; import { createGrowthEvidenceService } from './growth-evidence.js'; import { createEventService } from './events.js';
import { createModelProvider, listModelProviders, resolveModelConfig, resolveModelSelection } from './model-provider.js'; import { authenticateRequest, authMode, validateAuthStorage } from './auth.js'; import { buildRuntimeContext, findRegenerationTarget } from './runtime-context.js';
import { createSseEvent, formatSseEvent } from './sse.js'; import { queryCollection } from './collection-query.js'; import { agentAvatar, createAgentService, resolveMessageAvatar } from './agent-service.js'; import { collectSyncChanges } from './sync-service.js'; import { createObservability } from './observability.js';
import { createMusicService } from './music-service.js'; import { createNeteaseMusicAdapter } from './netease-music-adapter.js'; import { executeTool, findTool, getToolRisk, toOpenAITools } from './tools.js'; import { createPiClient } from './pi-client.js'; import { maybeCompactConversation } from './compaction.js';
import { mergeState } from './state-merge.js'; import { shouldRemember } from './auto-memory.js'; import { sanitizeWorkspacePreferences } from './workspace-preferences.js'; import { routeMessage } from './dynamic-alpha-router.js'; import { assertProductionDbSsl } from './db-ssl.js'; import { createAgentTaskService } from './agent-task.js';
import { verifyAgentTask, resolveVerificationWorkdir } from './verifier.js'; import { readTaskPatch, removeTaskSandbox, cleanupOrphanTaskSandboxes } from './task-sandbox.js'; import { loadWorkflowSpec, listWorkflows } from './workflows.js'; import { runCollaborationWorkflow } from './orchestrator.js';
import { createEvidenceLedger } from './evidence.js'; import { createProposalService } from './proposals.js'; import { applyProposalPatch } from './code-modifier.js'; import { createRunRegistry } from './runtime/runs.js'; import { createApprovalRegistry } from './runtime/approval.js'; import { createChatRuntime } from './runtime/chat-runtime.js'; import { createAgentRunner } from './runtime/agent-runner.js'; import { createInnerContinuity } from './runtime/inner-continuity.js'; import { createWakeEngine } from './runtime/wake-engine.js';
import { createRouter as createMiscRouter } from './routes/misc.js'; import { createRouter as createMusicRouter } from './routes/music.js'; import { createRouter as createSessionsRouter } from './routes/sessions.js'; import { createRouter as createAgentsRouter } from './routes/agents.js';
import { createRouter as createMemoriesRouter } from './routes/memories.js'; import { createRouter as createProfileRouter } from './routes/profile.js'; import { createRouter as createWorkflowsRouter } from './routes/workflows.js'; import { createRouter as createWorkbenchRouter } from './routes/workbench.js';
import { createRouter as createWakeRouter } from './routes/wake.js';
import { createRouter as createEventsRouter } from './routes/events.js';

const app = express(); const observability = createObservability({ rateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 120) }); const port = Number(process.env.PORT || 8787);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = clientOrigin.split(',').map(origin => origin.trim()).filter(Boolean);
const isPrivateDevelopmentOrigin = origin => {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    const url = new URL(origin);
    // Vite may use another port when 5173 is occupied; keep the host as the
    // development boundary while production remains config-only below.
    if (url.protocol !== 'http:') return false;
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
assertProductionDbSsl();
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
const memoryRuntime = createMemoryModuleRuntime({
  getState: () => requestContext.getStore()?.state || baseState,
  persistState: currentState => saveState(currentState),
  getUser: () => requestContext.getStore()?.user || { id: 'local-user' }
});
const agents = createAgentService(state, () => saveState(state)); const growthEvidence = createGrowthEvidenceService(state, () => saveState(state));
const activeRuns = new Map();
const streamRuns = new Map();
const dynamicAlphaObservations = [];
const recordDynamicAlphaObservation = ({ sessionId, mode, routing, modelProvider, modelName }) => {
  if (process.env.NODE_ENV === 'production') return;
  const sessionKey = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12);
  dynamicAlphaObservations.push({
    recordedAt: new Date().toISOString(),
    sessionKey,
    mode,
    modelProvider,
    modelName,
    scores: routing.scores,
    confAbs: routing.confAbs,
    confMargin: routing.confMargin,
    alphaRaw: routing.alphaRaw,
    alphaDecayed: routing.alphaDecayed,
    alphaWork: routing.alphaWork,
    alphaLove: routing.alphaLove,
    decision: routing.decision,
    placement: routing.placements?.[mode === 'work' ? 'work' : 'love'] || null,
    isAnchor: routing.isAnchor
  });
  if (dynamicAlphaObservations.length > 100) dynamicAlphaObservations.shift();
};
// 待确认的写操作：key = `${runId}:${toolCallId}` → resolve({ approved })
const pendingApprovals = new Map(); const approvalRecords = new Map(); const pendingAgentApprovals = new Map(); const sessionApprovalGrants = new Map();
const approvalTimeoutMs = Math.max(30_000, Number(process.env.APPROVAL_TIMEOUT_MS || 5 * 60 * 1000));
const sessionApprovalGrantTtlMs = Math.max(60_000, Number(process.env.APPROVAL_SESSION_TTL_MS || 30 * 60 * 1000));
const activeAgentRuns = new Map(); const activeVerifications = new Set(); const collaborationRuns = new Map();
const streamRetentionMs = Math.max(30_000, Number(process.env.SSE_RUN_RETENTION_MS || 300_000));
const chatRunTimeoutMs = Math.max(30_000, Number(process.env.CHAT_RUN_TIMEOUT_MS || 120_000));
const model = createModelProvider(); const music = createMusicService({ adapter: process.env.MUSIC_MODE === 'netease' ? createNeteaseMusicAdapter() : undefined });
const defaultModelSelection = () => {
  const provider = process.env.MODEL_PROVIDER || 'mock';
  const config = resolveModelConfig(provider);
  return { modelProvider: provider, modelName: config.model || config.suggestedModels?.[0] || 'mock' };
};
for (const session of state.sessions) {
  if (!session.modelProvider || !session.modelName) Object.assign(session, defaultModelSelection());
}
state.agents ||= [];
state.profile ||= { name: '', gender: 'none', age: null, avatar: '✦' };
state.mode ||= 'companion';
state.agentTasks ||= [];
state.evidence ||= [];
state.proposals ||= [];
state.collaborationRuns ||= [];
state.events ||= [];
for (const session of state.sessions) {
  session.mode ||= state.mode;
  session.companionIntent ||= 'listen';
}

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
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'
  });
  res.set('Content-Security-Policy', process.env.CSP || "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(observability.middleware);
app.use(async (req, res, next) => {
  const isApi = req.path.startsWith('/api/') || req.path.startsWith('/v1/') || req.path === '/mcp';
  const isPublic = req.path === '/api/health' || req.path === '/api/ready' || req.path === '/api/version' || req.path === '/api/metrics' || req.path === '/api/models';
  if (!isApi || isPublic || authMode() === 'off') {
    if (authMode() === 'off' && isApi) return requestContext.run({ user: { id: 'local-user', local: true }, state: baseState }, next);
    return next();
  }
  try {
    const user = await authenticateRequest(req);
    const userState = await loadUserState(user.id, baseState);
    req.cochpiaUserId = user.id;
    return requestContext.run({ user, state: userState }, next);
  } catch (error) { return next(error); }
});
app.use('/v1', memoryRuntime.router());

const send = (res, event, data, run) => {
  if (!run) return false;
  const entry = createSseEvent(run, event, data);
  const target = run.response || res;
  if (!target || target.writableEnded || target.destroyed) return false;
  target.write(formatSseEvent(entry));
  return true;
};
const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const sessionBelongsToCurrentUser = (session, ownerId = currentUserId()) => session && (session.ownerId ? session.ownerId === ownerId : authMode() === 'off');
const getSession = (id, ownerId = currentUserId()) => state.sessions.find(session => session.id === id && sessionBelongsToCurrentUser(session, ownerId));
const getMessage = (sessionId, messageId) => state.messages[sessionId]?.find(message => message.id === messageId);
const touchSession = session => { if (session) session.updatedAt = new Date().toISOString(); };
const runtimeKey = sessionId => `${requestContext.getStore()?.user?.id || 'local-user'}:${sessionId}`;
const currentUserId = () => requestContext.getStore()?.user?.id || 'local-user';
const chatMemoryForRequest = req => memoryRuntime.chatForRequest(req);
const compatibilityMemoryForRequest = req => memoryRuntime.compatibilityForRequest(req);
const approvalRegistry = createApprovalRegistry({ pendingApprovals, approvalRecords, sessionApprovalGrants, currentUserId, approvalTimeoutMs, sessionApprovalGrantTtlMs });
const agentTasks = createAgentTaskService({ state, persist: currentState => saveState(currentState) });
const events = createEventService(state, () => saveState(state));
// 注入对话上下文的「临近日程」:未绑定 Agent 的事件对全部 Agent 可见,绑定到某个 Agent 的只对它自己可见。
const collectUpcomingEvents = agentId => events.listUpcoming({ ownerId: currentUserId(), agentId: agentId || null, days: Number(process.env.UPCOMING_EVENT_DAYS || 7) });
const evidenceLedger = createEvidenceLedger(state);
const proposals = createProposalService(state, { apply: async (patch, proposal) => { applyProposalPatch(patch, proposal); } });
const agentTaskOwner = () => currentUserId();
const taskEvent = async (task, type, data = {}) => agentTasks.appendEvent(task, type, data);
const recordTaskEvidence = async (task, source, content, score = null) => {
  if (!content) return null;
  const item = evidenceLedger.record({ taskId: task.id, stageId: task.stageId, source, content, score });
  await saveState(state);
  return item;
};
void Promise.all(state.agentTasks.filter(task => ['running', 'verifying'].includes(task.status)).map(async task => {
  const previousStatus = task.status;
  task.status = 'failed';
  task.message = previousStatus === 'running' ? 'agent_execution_interrupted' : 'verification_interrupted';
  await taskEvent(task, 'task_interrupted', { reason: 'server_restart', previousStatus });
}));
const workflowHooks = { trigger: null };
const { runAgentTask, taskScheduler } = createAgentRunner({ state, agentTasks, createPiClient, activeAgentRuns, pendingAgentApprovals, taskEvent, recordTaskEvidence, workflowHooks });
const innerContinuity = createInnerContinuity({ state, saveState: currentState => saveState(currentState) });
const wakeEngine = createWakeEngine({ state, saveState: currentState => saveState(currentState), innerContinuity, agents, model, createModelProvider, resolveModelSelection, getSession, chatMemoryForRequest, randomUUID, agentAvatar, buildRuntimeContext, collectUpcomingEvents });
const runRegistry = createRunRegistry({ activeRuns, streamRuns, send, streamRetentionMs });
const { finishRun, attachStreamResponse } = runRegistry;
const chatRuntime = createChatRuntime({
  state, saveState, getSession, touchSession, currentUserId, runtimeKey,
  agents, agentAvatar, createModelProvider, resolveModelSelection,
  buildRuntimeContext, findRegenerationTarget, routeMessage,
  recordDynamicAlphaObservation, chatMemoryForRequest, shouldRemember,
  maybeCompactConversation, executeTool, findTool, getToolRisk, toOpenAITools,
  innerContinuity,
  wakeEngine,
  collectUpcomingEvents,
  createPiClient, agentTasks, taskScheduler, send, fail, activeRuns, streamRuns,
  attachStreamResponse, finishRun, chatRunTimeoutMs,
  waitForApproval: approvalRegistry.waitForApproval, randomUUID
});

const routeDeps = { state, saveState, fail, getSession, getMessage, touchSession, currentUserId, sessionBelongsToCurrentUser, agentTaskOwner, agents, resolveMessageAvatar, music, observability, model, storageProvider, getStorageStatus, listModelProviders, dynamicAlphaObservations, queryCollection, randomUUID, defaultModelSelection, resolveModelSelection, createModelProvider, compatibilityMemoryForRequest, chatMemoryForRequest, memoryRuntime, collectSyncChanges, mergeState, sanitizeWorkspacePreferences, growthEvidence, events, collaborationRuns, loadWorkflowSpec, listWorkflows, runCollaborationWorkflow, proposals, agentTasks, taskScheduler, taskEvent, recordTaskEvidence, activeAgentRuns, activeVerifications, verifyAgentTask, resolveVerificationWorkdir, path, fs, readTaskPatch, removeTaskSandbox, pendingAgentApprovals, activeRuns, streamRuns, runtimeKey, attachStreamResponse, send, finishRun, approvalRegistry, chatRuntime, workflowHooks };
app.use('/', createMiscRouter(routeDeps));
app.use('/', createMusicRouter(routeDeps));
app.use('/', createSessionsRouter(routeDeps));
app.use('/', createAgentsRouter(routeDeps));
app.use('/', createMemoriesRouter(routeDeps));
app.use('/', createProfileRouter(routeDeps));
app.use('/', createWorkflowsRouter(routeDeps));
app.use('/', createWorkbenchRouter(routeDeps));
app.use('/', createWakeRouter(routeDeps));
app.use('/', createEventsRouter(routeDeps));

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
app.listen(port, () => {
  console.log(`Cochpia server listening on http://localhost:${port}`);
  void cleanupOrphanTaskSandboxes({ maxAgeMs: Number(process.env.TASK_SANDBOX_MAX_AGE_MS) || 24 * 60 * 60 * 1000 });
});
