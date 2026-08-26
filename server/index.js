import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getStorageStatus, loadState, loadUserState, saveState, storageProvider } from './store.js';
import { createMemoryModuleRuntime } from './memory-module-runtime.js';
import { createGrowthEvidenceService } from './growth-evidence.js';
import { listModelProviders, resolveModelConfig, resolveModelSelection, validateProductionModelPolicy } from './model-provider.js';
import { createCompanionModelGateway } from './companion-model-gateway.js';
import { authenticateRequest, authMode, validateAuthStorage, validateProductionAuth } from './auth.js';
import { validateProductionDbTls } from './db-ssl.js';
import { queryCollection } from './collection-query.js';
import { createTaskService, statuses as taskStatuses } from './task-service.js';
import { createEventService } from './event-service.js';
import { createAgentService } from './agent-service.js';
import { collectSyncChanges } from './sync-service.js';
import { createObservability } from './observability.js';
import { createMusicService } from './music-service.js';
import { createNeteaseMusicAdapter } from './netease-music-adapter.js';
import { assertMcpWriteAuthorized } from './mcp-policy.js';
import { ensurePsychologyTraits, listAtmospherePresets, resolveAtmosphere } from './psychology.js';
import { sanitizeWorkspacePreferences } from './workspace-preferences.js';
import { createInteractionCollector } from './interaction-collector.js';
import { createContextBuilder } from './context-builder.js';
import { createInteractionFinalizer } from './interaction-finalizer.js';
import { createCompanionOrchestrator } from './companion-orchestrator.js';
import { createCompanionInteractionAdapters } from './interaction-adapters.js';
import { createLifeStateService } from './life-state.js';
import { eventIdFor, reconcileChat, repairChat } from './companion-reconciliation.js';
import { createRelationshipStateService } from './relationship-state.js';
import { createPersonalityProjection } from './personality-projection.js';
import { buildLifeCompanionContext } from './life-context.js';
import { parseClientOrigins, validateProductionCors } from './cors-policy.js';
import { createCompanionChatRuntime } from './chat-runtime.js';
import { createCompanionChatController } from './chat-controller.js';
import { getCompanionCurrentState } from './companion-current-state.js';
import { createUploadStore, ensureUploadOwnerKey } from './upload-store.js';
import { createMemoryWriteIngress, createMcpWriteIngress } from './mcp-write.js';
import {
  ensureLifeEventGovernanceState,
  findLifeEventGovernance,
  reconcileLifeEventGovernance
} from './life-event-governance.js';
import { createCompanionLifeRuntime } from './life-runtime.js';
import {
  ensureCompanionGovernanceState
} from './companion-governance.js';
import { createCompanionProductRuntime } from './product-runtime.js';

const app = express();
const observability = createObservability({ rateLimitMax: Number(process.env.API_RATE_LIMIT_MAX || 120) });
const port = Number(process.env.PORT || 8787);
const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase();
const clientOrigin = process.env.CLIENT_ORIGIN || (nodeEnv === 'production' ? '' : 'http://localhost:5173');
const allowedOrigins = parseClientOrigins(clientOrigin);
validateProductionCors({ nodeEnv, clientOrigin });
const isPrivateDevelopmentOrigin = origin => {
  if (nodeEnv === 'production') return false;
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
validateProductionAuth();
validateAuthStorage(storageProvider);
validateProductionDbTls({ storageProvider });
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
  defineProperty(target, property, descriptor) {
    const current = requestContext.getStore()?.state || target;
    Object.defineProperty(current, property, descriptor);
    return true;
  },
  deleteProperty(target, property) {
    const current = requestContext.getStore()?.state || target;
    return delete current[property];
  },
  ownKeys(target) { return Reflect.ownKeys(requestContext.getStore()?.state || target); },
  getOwnPropertyDescriptor(target, property) {
    const current = requestContext.getStore()?.state || target;
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor) return { ...descriptor, configurable: true };
    return { configurable: true, enumerable: true, value: current[property], writable: true };
  }
});
const memoryRuntime = createMemoryModuleRuntime({
  getState: () => requestContext.getStore()?.state || baseState,
  persistState: currentState => saveState(currentState, { bumpCommitSequence: false }),
  getUser: () => requestContext.getStore()?.user || { id: 'local-user' }
});
const interactionCollector = createInteractionCollector({
  contextFromRequest: req => memoryRuntime.contextFromRequest(req, { chat: true }),
  appendEvent: (context, input, { request }) => memoryRuntime.moduleForRequest(request).recordEvent(context, input)
});
const collectApiMemoryWriteRequest = createMemoryWriteIngress({ collector: interactionCollector, producer: 'memory-api-adapter', sourcePrefix: 'api' });
const contextBuilder = createContextBuilder();
const interactionFinalizer = createInteractionFinalizer({ collector: interactionCollector });
const companionOrchestrator = createCompanionOrchestrator({ collector: interactionCollector, contextBuilder, finalizer: interactionFinalizer });
const agents = createAgentService(state, () => saveState(state));
const growthEvidence = createGrowthEvidenceService(state, () => saveState(state));
const uploadStore = createUploadStore();
state.companion ||= {};
state.companion.sessionMappings ||= {};
ensureCompanionGovernanceState(state);
ensureLifeEventGovernanceState(state);
state.relationshipStates ||= {};
const lifeState = createLifeStateService(state, () => saveState(state));
const relationships = createRelationshipStateService(state, () => saveState(state));
const {
  calendarInteractionInput,
  collectLifeEvent,
  flushProductInteractionOutbox,
  productInteractionInput,
  queueProductInteraction,
  redactInteractionText,
  rollbackInteractionOutbox,
  taskInteractionInput
} = createCompanionInteractionAdapters({
  state,
  persist: () => saveState(state),
  memoryRuntime,
  interactionCollector,
  relationships,
  lifeState,
  growthEvidence
});

const tasks = createTaskService(state, () => saveState(state), {
  onMutation: mutation => queueProductInteraction(taskInteractionInput(mutation), { required: true }),
  onMutationRollback: rollbackInteractionOutbox
});
const events = createEventService(state, () => saveState(state), {
  onMutation: mutation => queueProductInteraction(calendarInteractionInput(mutation), { required: true }),
  onMutationRollback: rollbackInteractionOutbox
});
validateProductionModelPolicy({ provider: process.env.MODEL_PROVIDER || 'mock' });
const model = createCompanionModelGateway();
const music = createMusicService({ adapter: process.env.MUSIC_MODE === 'netease' ? createNeteaseMusicAdapter() : undefined });
const runMusicCommand = async (req, action, operation) => {
  const result = await operation();
  const requestKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || req.body?.idempotency_key || `${action}:${randomUUID()}`).slice(0, 120);
  const eventId = `music:${currentUserId()}:${action}:${requestKey}`;
  const track = result?.track || null;
  const queued = queueProductInteraction(productInteractionInput({
    eventType: 'music.playback.changed',
    producer: 'music-adapter',
    sourceType: 'music',
    sourceId: `music:${currentUserId()}`,
    eventId,
    content: `Music playback ${action}`,
    structuredData: {
      action,
      state: result?.state || null,
      track: track ? {
        id: redactInteractionText(track.id),
        title: redactInteractionText(track.title),
        artist: redactInteractionText(track.artist),
        album: redactInteractionText(track.album)
      } : null
    }
  }), { required: true });
  const entry = queued;
  if (entry) {
    try {
      await saveState(state);
    } catch (error) {
      const persistenceError = Object.assign(error, {
        code: 'MUSIC_INTERACTION_OUTBOX_PERSIST_FAILED',
        causeCode: error.code || null,
        status: error.status || 503,
        retryable: error.retryable ?? true
      });
      console.error(JSON.stringify({ event: 'music_interaction_outbox_persist_failed', code: persistenceError.code }));
      throw persistenceError;
    }
    await flushProductInteractionOutbox(req);
  }
  const current = entry ? state.companion.interactionOutbox.find(item => item.id === entry.id) : null;
  return {
    ...result,
    interactionEvent: {
      status: current?.status || 'not_queued',
      outboxId: current?.id || null,
      rawEventId: current?.rawEventId || null,
      errorCode: current?.lastErrorCode || null
    }
  };
};
const defaultModelSelection = () => {
  const provider = process.env.MODEL_PROVIDER || 'mock';
  const config = resolveModelConfig(provider);
  return { modelProvider: provider, modelName: config.model || config.suggestedModels?.[0] || 'mock' };
};
for (const session of state.sessions) {
  if (!session.modelProvider || !session.modelName) Object.assign(session, defaultModelSelection());
}
state.tasks ||= [];
state.events ||= [];
state.agents ||= [];
state.uploads ||= [];
state.profile ||= { name: 'Cochpia', gender: 'none', age: null, avatar: '✦' };
state.mode ||= 'companion';
ensurePsychologyTraits(state.personality);
const personalityProjection = createPersonalityProjection(state);
const {
  lifeStateForResponse,
  runLifeEventGovernance,
  sendLifeEventResponse
} = createCompanionLifeRuntime({
  state,
  persist: () => saveState(state),
  memoryRuntime,
  relationships,
  personalityProjection
});

app.use((req, res, next) => {
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || (nodeEnv !== 'production' && isPrivateDevelopmentOrigin(origin))) return callback(null, true);
      if (nodeEnv !== 'production' && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`)) return callback(null, true);
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
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '8mb' }));
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
    return requestContext.run({ user, state: userState }, next);
  } catch (error) { return next(error); }
});
app.use('/v1', memoryRuntime.router({ internalOnly: true, internalServiceToken: process.env.MEMORY_INTERNAL_SERVICE_TOKEN || '' }));

const chatRuntime = createCompanionChatRuntime({ state, storageProvider });

const fail = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const apiMemoryMutationInput = req => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = body.idempotencyKey ?? body.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) {
    throw Object.assign(new Error('Header and body idempotency keys do not match'), { code: 'IDEMPOTENCY_KEY_CONFLICT', status: 400 });
  }
  if (headerKey) body.idempotency_key = headerKey;
  return body;
};
const numericSourceRevision = value => /^\d+$/.test(String(value ?? '').trim()) ? BigInt(String(value).trim()) : null;
const compareSourceRevisions = (left, right) => {
  const leftRevision = numericSourceRevision(left?.sourceRevision);
  const rightRevision = numericSourceRevision(right?.sourceRevision);
  if (leftRevision != null && rightRevision != null) return leftRevision < rightRevision ? -1 : leftRevision > rightRevision ? 1 : 0;
  if (leftRevision != null && rightRevision == null) return 1;
  if (leftRevision == null && rightRevision != null) return -1;
  return new Date(left?.createdAt || 0).getTime() - new Date(right?.createdAt || 0).getTime();
};
const chatRawEventsForMessage = (memory, memorySessionId, sessionId, messageId) => (memory.state.rawEvents || [])
  .filter(event => event.sessionId === memorySessionId && event.eventId === eventIdFor(sessionId, messageId))
  .sort(compareSourceRevisions);
const nextChatMessageRevision = (message, rawEvents) => {
  const messageRevision = numericSourceRevision(message?.sourceRevision ?? message?.source_revision);
  const latestRevision = rawEvents.reduce((latest, event) => {
    const revision = numericSourceRevision(event.sourceRevision);
    return revision != null && (latest == null || revision > latest) ? revision : latest;
  }, null);
  return String((messageRevision ?? latestRevision ?? 0n) + 1n);
};
const getSession = id => state.sessions.find(session => session.id === id);
const sessionForResponse = session => ({ ...session, currentState: getCompanionCurrentState(session) });
const getMessage = (sessionId, messageId) => state.messages[sessionId]?.find(message => message.id === messageId);
const touchSession = session => { if (session) session.updatedAt = new Date().toISOString(); };
const currentUserId = () => requestContext.getStore()?.user?.id || 'local-user';
const productRuntime = createCompanionProductRuntime({
  state,
  baseState,
  getState: () => requestContext.getStore()?.state || baseState,
  persist: options => saveState(state, options),
  storageProvider,
  nodeEnv,
  memoryRuntime,
  uploadStore,
  chatStreamJournal: chatRuntime.chatStreamJournal,
  disableChatStreamJournals: chatRuntime.disableChatStreamJournals,
  activeRuns: chatRuntime.activeRuns,
  activeGroupRuns: chatRuntime.activeGroupRuns,
  pendingRunReservations: chatRuntime.pendingRunReservations,
  hasActiveUserInteraction: chatRuntime.hasActiveUserInteraction,
  currentUserId
});
app.use('/api', (req, res, next) => {
  if (req.path === '/account' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (productRuntime.isAccountDeletionInProgress(currentUserId())) return fail(res, 409, 'ACCOUNT_DELETE_IN_PROGRESS', 'Account deletion is in progress');
  return next();
});
const chatMemoryForRequest = (req, sessionId = undefined) => memoryRuntime.chatForRequest(req, sessionId);
const compatibilityMemoryForRequest = req => memoryRuntime.compatibilityForRequest(req);
const chatController = createCompanionChatController({
  state,
  memoryRuntime,
  companionOrchestrator,
  relationships,
  events,
  agents,
  growthEvidence,
  productRuntime,
  chatRuntime,
  saveState,
  getSession,
  touchSession,
  currentUserId,
  chatMemoryForRequest
});
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
app.post('/api/music/play', async (req, res) => { try { res.json(await runMusicCommand(req, 'play', () => music.play(req.body?.track))); } catch (error) { fail(res, 503, error.code || 'MUSIC_PLAY_FAILED', error.message); } });
app.post('/api/music/pause', async (req, res) => { try { res.json(await runMusicCommand(req, 'pause', () => music.pause())); } catch (error) { fail(res, 503, error.code || 'MUSIC_PAUSE_FAILED', error.message); } });
app.post('/api/music/resume', async (req, res) => { try { res.json(await runMusicCommand(req, 'resume', () => music.resume())); } catch (error) { fail(res, 503, error.code || 'MUSIC_RESUME_FAILED', error.message); } });
app.post('/api/music/next', async (req, res) => { try { res.json(await runMusicCommand(req, 'next', () => music.next())); } catch (error) { fail(res, 503, error.code || 'MUSIC_NEXT_FAILED', error.message); } });
app.post('/api/music/stop', async (req, res) => { try { res.json(await runMusicCommand(req, 'stop', () => music.stop())); } catch (error) { fail(res, 503, error.code || 'MUSIC_STOP_FAILED', error.message); } });
app.get('/api/sessions', (req, res) => {
  const sessions = state.sessions.map(sessionForResponse);
  if (req.query.paginated !== 'true' && !req.query.search && req.query.archived === undefined) return res.json(sessions);
  const result = queryCollection(sessions, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, filter: session => req.query.archived === 'true' ? session.archived === true : req.query.archived === 'false' ? session.archived !== true : true });
  const items = result.items.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(req.query.paginated === 'true' ? { ...result, items } : items);
});
app.post('/api/sessions', async (req, res) => {
  const session = { id: randomUUID(), title: String(req.body?.title || '新的相遇').slice(0, 80), kind: req.body?.kind === 'group' ? 'group' : 'private', agentIds: Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String).slice(0, 20) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...defaultModelSelection() };
  state.sessions.unshift(session); state.messages[session.id] = [];
  try {
    await memoryRuntime.ensureChatSession(req, session.id);
    await saveState(state);
    res.status(201).json(session);
  } catch (error) {
    state.sessions = state.sessions.filter(item => item.id !== session.id);
    delete state.messages[session.id];
    await saveState(state).catch(() => {});
    fail(res, error.status || 503, error.code || 'MEMORY_SESSION_CREATE_FAILED', error.message);
  }
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
  if (!selection.ok) return fail(res, ['MODEL_NOT_CONFIGURED', 'MODEL_EXTERNAL_POLICY_REQUIRED'].includes(selection.code) ? 503 : 400, selection.code, selection.error);
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
  try {
    const memorySessionId = await memoryRuntime.ensureChatSession(req, req.params.id);
    const memory = memoryRuntime.moduleForRequest(req);
    const context = { ...memoryRuntime.contextFromRequest(req, { chat: true, sessionId: memorySessionId }), relationshipId: relationships.relationshipId('cochpia') };
    const rawEvents = chatRawEventsForMessage(memory, memorySessionId, req.params.id, req.params.messageId);
    const sourceRevision = nextChatMessageRevision(message, rawEvents);
    const previous = structuredClone(message);
    const session = getSession(req.params.id);
    const previousSessionUpdatedAt = session.updatedAt;
    const eventType = message.role === 'assistant' ? 'conversation.assistant_message.completed' : 'conversation.user_message.created';
    const producer = message.role === 'assistant' ? 'chat-finalizer' : 'chat-adapter';
    const collected = await interactionCollector.collect({
      event_id: eventIdFor(req.params.id, req.params.messageId),
      event_type: eventType,
      source_type: 'chat',
      source_id: req.params.id,
      session_id: req.params.id,
      source_revision: sourceRevision,
      is_final: true,
      event_status: 'final',
      content_type: 'plain_text',
      content: content.slice(0, 8000),
      correlation_id: req.params.messageId,
      producer,
      privacy_directive: 'default',
      structured_data: { message_id: req.params.messageId, channel: String(message.channel || '默认').slice(0, 60), edited: true },
      idempotency_key: req.get('Idempotency-Key') || `message-edit:${req.params.id}:${req.params.messageId}:${sourceRevision}`
    }, {
      request: req,
      context,
      allowInternal: message.role === 'assistant',
      sourceId: req.params.id,
      sessionId: req.params.id,
      producer,
      storageSessionId: memorySessionId
    });
    message.content = content.slice(0, 8000);
    message.sourceRevision = sourceRevision;
    message.updatedAt = new Date().toISOString();
    touchSession(getSession(req.params.id));
    try {
      await saveState(state);
    } catch (error) {
      for (const key of Object.keys(message)) if (!Object.hasOwn(previous, key)) delete message[key];
      Object.assign(message, previous);
      session.updatedAt = previousSessionUpdatedAt;
      if (collected.rawEventId) {
        try {
          await memory.deleteSourceEvent(context, collected.rawEventId, {
            resourceRevision: 1,
            idempotency_key: `message-edit-rollback:${req.params.id}:${req.params.messageId}:${sourceRevision}`
          });
        } catch (rollbackError) {
          console.error(JSON.stringify({ event: 'message_edit_memory_rollback_failed', code: rollbackError.code || 'MESSAGE_EDIT_MEMORY_ROLLBACK_FAILED' }));
        }
      }
      throw error;
    }
    return res.json(message);
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'MESSAGE_EDIT_FAILED', error.message);
  }
});
app.delete('/api/sessions/:id/messages/:messageId', async (req, res) => {
  if (!getSession(req.params.id)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const messages = state.messages[req.params.id] || [];
  const index = messages.findIndex(message => message.id === req.params.messageId);
  if (index === -1) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message not found');
  try {
    const memorySessionId = await memoryRuntime.ensureChatSession(req, req.params.id);
    const memory = memoryRuntime.moduleForRequest(req);
    const context = memoryRuntime.contextFromRequest(req, { chat: true, sessionId: memorySessionId });
    const rawEvents = chatRawEventsForMessage(memory, memorySessionId, req.params.id, req.params.messageId);
    const memoryDeletions = [];
    for (const rawEvent of rawEvents) {
      memoryDeletions.push(await memory.deleteSourceEvent(context, rawEvent.id, {
        resourceRevision: rawEvent.resourceRevision || 1,
        idempotency_key: `${req.get('Idempotency-Key') || `message-delete:${req.params.id}:${req.params.messageId}`}:${rawEvent.id}`
      }));
    }
    messages.splice(index, 1);
    touchSession(getSession(req.params.id));
    await saveState(state);
    return res.json({ deleted: true, messageId: req.params.messageId, memoryDeletion: memoryDeletions.at(-1) || null, memoryDeletions });
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'MESSAGE_DELETE_FAILED', error.message);
  }
});
app.get('/api/sessions/:id/reconciliation', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  try {
    const memorySessionId = await memoryRuntime.ensureChatSession(req, session.id);
    const memory = memoryRuntime.moduleForRequest(req);
    res.json(reconcileChat({ sessionId: session.id, messages: state.messages[session.id] || [], rawEvents: memory.state.rawEvents || [] }));
  } catch (error) {
    fail(res, error.status || 503, error.code || 'RECONCILIATION_FAILED', error.message);
  }
});
app.post('/api/sessions/:id/reconciliation/repair', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  try {
    const memorySessionId = await memoryRuntime.ensureChatSession(req, session.id);
    const context = memoryRuntime.contextFromRequest(req, { chat: true, sessionId: memorySessionId });
    const memory = memoryRuntime.moduleForRequest(req);
    const result = await repairChat({
      sessionId: session.id,
      messages: state.messages[session.id] || [],
      rawEvents: memory.state.rawEvents || [],
      collectEvent: expected => interactionCollector.collect({
        event_id: expected.eventId,
        event_type: expected.eventType,
        source_type: expected.sourceType,
        source_id: expected.sourceId,
        session_id: expected.sessionId,
        source_revision: expected.sourceRevision,
        is_final: expected.isFinal,
        content_type: expected.contentType,
        content: expected.content,
        structured_data: { channel: expected.channel, repaired: true },
        correlation_id: expected.correlationId,
        producer: expected.producer
      }, { request: req, context, allowInternal: expected.allowInternal, sourceId: session.id, sessionId: session.id, producer: expected.producer, storageSessionId: memorySessionId })
    });
    res.json(result);
  } catch (error) {
    fail(res, error.status || 503, error.code || 'REPAIR_FAILED', error.message);
  }
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
  touchSession(session); await saveState(state); res.json(sessionForResponse(session));
});
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    return res.json(await productRuntime.deleteSession(req, req.params.id));
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'SESSION_DELETE_FAILED', error.message);
  }
});
app.get('/api/life/actions', (_, res) => res.json({ actions: lifeState.listActions() }));
app.get('/api/life/state', (_, res) => res.json({ state: lifeStateForResponse(lifeState.get()), actions: lifeState.listActions() }));
app.get('/api/life/context', async (req, res) => {
  try {
    const applicationSessionId = String(req.query?.sessionId || req.query?.session_id || '').trim() || null;
    if (applicationSessionId && !getSession(applicationSessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const memory = await memoryRuntime.prepareForRequest(req);
    const memorySessionId = applicationSessionId ? await memoryRuntime.ensureChatSession(req, applicationSessionId) : null;
    const interactionContext = { ...memoryRuntime.contextFromRequest(req, { chat: true, sessionId: memorySessionId }), relationshipId: relationships.relationshipId('cochpia') };
    const tokenBudget = Math.max(256, Math.min(2400, Math.floor(Number(req.query?.tokenBudget || req.query?.token_budget || 1200))));
    const memoryBundle = await memory.contextBundleAsync(interactionContext, { purpose: 'profile_view', tokenBudget });
    const session = applicationSessionId ? getSession(applicationSessionId) : null;
    const context = buildLifeCompanionContext({
      contextBuilder,
      identity: { ...interactionContext, sessionId: applicationSessionId },
      session: session ? { id: session.id, title: session.title, kind: session.kind } : null,
      personality: state.personality,
      relationship: relationships.get('cochpia'),
      lifeState: lifeState.get(),
      memoryBundle,
      profile: state.profile,
      mode: state.mode,
      boundaries: state.boundaries || {},
      upcomingEvents: events.listUpcoming(7),
      tokenBudget
    });
    return res.json({ context, policy: { purpose: 'profile_view', result: memoryBundle.policyResult, consistencyToken: memoryBundle.consistencyToken } });
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'LIFE_CONTEXT_FAILED', error.message);
  }
});
app.post('/api/life/actions', async (req, res) => {
  const actionId = String(req.body?.actionId || req.body?.action_id || '').trim();
  const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim() || null;
  if (sessionId && !getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await lifeState.advance(actionId, { idempotencyKey: headerKey || bodyKey, expectedRevision: req.body?.expectedRevision ?? req.body?.resourceRevision, sessionId });
    const event = await collectLifeEvent(req, sessionId, result.event);
    return sendLifeEventResponse(res, result, event);
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'LIFE_ACTION_FAILED', error.message);
  }
});
app.post('/api/life/decisions', async (req, res) => {
  const optionId = String(req.body?.optionId || req.body?.option_id || '').trim();
  const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim() || null;
  if (sessionId && !getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await lifeState.resolveDecision(optionId, { idempotencyKey: headerKey || bodyKey, expectedRevision: req.body?.expectedRevision ?? req.body?.resourceRevision, sessionId });
    const event = await collectLifeEvent(req, sessionId, result.event);
    return sendLifeEventResponse(res, result, event);
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'LIFE_DECISION_FAILED', error.message);
  }
});
app.post('/api/life/reset', async (req, res) => {
  const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim() || null;
  if (sessionId && !getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await lifeState.reset({ idempotencyKey: headerKey || bodyKey, expectedRevision: req.body?.expectedRevision ?? req.body?.resourceRevision, sessionId });
    const event = await collectLifeEvent(req, sessionId, result.event);
    return sendLifeEventResponse(res, result, event);
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'LIFE_RESET_FAILED', error.message);
  }
});
app.post('/api/life/mode', async (req, res) => {
  const sessionId = String(req.body?.sessionId || req.body?.session_id || '').trim() || null;
  if (sessionId && !getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await lifeState.setMode(req.body?.mode, { idempotencyKey: headerKey || bodyKey, expectedRevision: req.body?.expectedRevision ?? req.body?.resourceRevision, sessionId });
    const event = await collectLifeEvent(req, sessionId, result.event);
    return sendLifeEventResponse(res, result, event);
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'LIFE_MODE_CHANGE_FAILED', error.message);
  }
});
app.get('/api/life/events/:id/governance', async (req, res) => {
  try {
    const memory = await memoryRuntime.prepareForRequest(req);
    const operation = findLifeEventGovernance(state, { identifier: req.params.id });
    if (!operation) return fail(res, 404, 'LIFE_EVENT_GOVERNANCE_NOT_FOUND', 'Life event governance operation not found');
    return res.json({ operation, reconciliation: reconcileLifeEventGovernance({ state, memory, operation }) });
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'LIFE_EVENT_GOVERNANCE_STATUS_FAILED', error.message);
  }
});

app.post('/api/life/governance/:operationId/repair', async (req, res) => {
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const operation = findLifeEventGovernance(state, { operationId: req.params.operationId });
    if (!operation) return fail(res, 404, 'LIFE_EVENT_GOVERNANCE_NOT_FOUND', 'Life event governance operation not found');
    const result = await runLifeEventGovernance(req, {
      action: operation.action,
      identifier: operation.rawEventId,
      operationId: operation.id,
      idempotencyKey: headerKey || bodyKey || operation.idempotencyKey
    });
    return res.json({ repaired: true, ...result });
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'LIFE_EVENT_REPAIR_FAILED', error.message);
  }
});

app.post('/api/life/events/:id/forget', async (req, res) => {
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await runLifeEventGovernance(req, { action: 'forget', identifier: req.params.id, idempotencyKey: headerKey || bodyKey });
    return res.json({ forgotten: true, eventId: result.operation.eventId, operation: result.operation, memoryDeletion: result.memoryDeletion, projections: result.projections, reconciliation: result.reconciliation });
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'LIFE_EVENT_FORGET_FAILED', error.message);
  }
});

app.delete('/api/life/events/:id', async (req, res) => {
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await runLifeEventGovernance(req, { action: 'delete', identifier: req.params.id, idempotencyKey: headerKey || bodyKey });
    return res.json({ deleted: true, eventId: result.operation.eventId, operation: result.operation, memoryDeletion: result.memoryDeletion, projections: result.projections, reconciliation: result.reconciliation });
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'LIFE_EVENT_DELETE_FAILED', error.message);
  }
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
    const task = await tasks.create(req.body || {});
    await flushProductInteractionOutbox(req);
    res.status(201).json(task);
  } catch (error) { fail(res, error.status || 400, error.code || 'INVALID_TASK', error.message); }
});
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    if (req.body?.sessionId && !getSession(req.body.sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const task = await tasks.update(req.params.id, req.body || {});
    if (task) await flushProductInteractionOutbox(req);
    task ? res.json(task) : fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
  } catch (error) { fail(res, error.status || 400, error.code || 'INVALID_TASK', error.message); }
});
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const removed = await tasks.remove(req.params.id);
    if (removed) await flushProductInteractionOutbox(req);
    removed ? res.status(204).end() : fail(res, 404, 'TASK_NOT_FOUND', 'Task not found');
  } catch (error) { fail(res, error.status || 503, error.code || 'TASK_DELETE_FAILED', error.message); }
});
app.get('/api/events', (req, res) => {
  const type = req.query.type ? String(req.query.type) : '';
  if (type && !['anniversary', 'birthday', 'plan', 'record'].includes(type)) return fail(res, 400, 'INVALID_EVENT_TYPE', 'Invalid event type');
  res.json(events.list({ type, upcomingDays: req.query.upcomingDays ? Number(req.query.upcomingDays) : undefined }));
});
app.post('/api/events', async (req, res) => { try { const event = await events.create(req.body || {}); await flushProductInteractionOutbox(req); res.status(201).json(event); } catch (error) { fail(res, error.status || 400, error.code || 'INVALID_EVENT', error.message); } });
app.patch('/api/events/:id', async (req, res) => { try { const event = await events.update(req.params.id, req.body || {}); if (event) await flushProductInteractionOutbox(req); event ? res.json(event) : fail(res, 404, 'EVENT_NOT_FOUND', 'Event not found'); } catch (error) { fail(res, error.status || 400, error.code || 'INVALID_EVENT', error.message); } });
app.delete('/api/events/:id', async (req, res) => { try { const removed = await events.remove(req.params.id); if (removed) await flushProductInteractionOutbox(req); removed ? res.status(204).end() : fail(res, 404, 'EVENT_NOT_FOUND', 'Event not found'); } catch (error) { fail(res, error.status || 503, error.code || 'EVENT_DELETE_FAILED', error.message); } });
app.get('/api/agents', (_, res) => res.json(agents.list()));
app.post('/api/agents', async (req, res) => { try { res.status(201).json(await agents.create(req.body || {})); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
app.patch('/api/agents/:id', async (req, res) => { try { const agent = await agents.update(req.params.id, req.body || {}); agent ? res.json(agent) : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); } catch (error) { fail(res, 400, 'INVALID_AGENT', error.message); } });
app.delete('/api/agents/:id', async (req, res) => { const removed = await agents.remove(req.params.id); removed ? res.status(204).end() : fail(res, 404, 'AGENT_NOT_FOUND', 'Agent not found'); });
app.get('/api/sync', async (req, res) => {
  try {
    await memoryRuntime.prepareForRequest(req);
    return res.json({ version: 1, syncedAt: new Date().toISOString(), ...collectSyncChanges(state, { cursor: req.query.cursor, limit: req.query.limit }) });
  } catch (error) { return fail(res, error.status || 400, error.code || 'INVALID_SYNC_CURSOR', error.message); }
});
app.get('/api/memories', async (req, res) => {
  const memories = await compatibilityMemoryForRequest(req).list(req.query.paginated === 'true' ? { ...req.query, limit: 100 } : req.query);
  if (req.query.paginated !== 'true') return res.json(memories);
  const result = queryCollection(memories, { search: req.query.search, limit: req.query.limit, offset: req.query.offset, text: item => `${item.summary} ${item.type} ${item.source}` });
  return res.json(result);
});
app.post('/api/memories', async (req, res) => {
  try {
    const ingress = await collectApiMemoryWriteRequest({ request: req, id: req.requestId, name: 'hold', args: req.body || {} });
    const input = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    res.status(201).json(await compatibilityMemoryForRequest(req).hold({
      ...input,
      idempotency_key: input.idempotency_key || input.idempotencyKey || ingress.envelope?.idempotency_key,
      sourceEventId: ingress.rawEventId || null
    }));
  } catch (error) { fail(res, error.status || 400, error.code || 'INVALID_MEMORY', error.message); }
});
app.get('/api/memories/export', async (req, res) => {
  const memories = await compatibilityMemoryForRequest(req).exportMemories();
  res.set('Content-Disposition', 'attachment; filename="cochpia-memories.json"');
  res.json({ exportedAt: new Date().toISOString(), version: 1, memories });
});
app.post('/api/export-operations', async (req, res) => {
  const headerKey = req.get('Idempotency-Key');
  const bodyKey = req.body?.idempotencyKey || req.body?.idempotency_key;
  if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) return fail(res, 400, 'IDEMPOTENCY_KEY_CONFLICT', 'Header and body idempotency keys do not match');
  try {
    const result = await productRuntime.createExport(req, {
      idempotencyKey: headerKey || bodyKey,
      requestId: req.requestId
    });
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'EXPORT_OPERATION_CREATE_FAILED', error.message);
  }
});
app.get('/api/export-operations/:id', async (req, res) => {
  try {
    const operation = await productRuntime.exportStatus(req, req.params.id);
    if (!operation) return fail(res, 404, 'EXPORT_OPERATION_NOT_FOUND', 'Product export operation not found');
    return res.json(operation);
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'EXPORT_OPERATION_STATUS_FAILED', error.message);
  }
});
app.get('/api/export-operations/:id/data', async (req, res) => {
  try {
    const data = await productRuntime.downloadExport(req, req.params.id);
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="cochpia-export.json"' });
    return res.json(data);
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'EXPORT_DOWNLOAD_FAILED', error.message);
  }
});
app.get('/api/export', async (req, res) => {
  try {
    const result = await productRuntime.createExport(req, {
      idempotencyKey: `legacy-get:${req.requestId || randomUUID()}`,
      requestId: req.requestId
    });
    const data = await productRuntime.downloadExport(req, result.operation.id);
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="cochpia-export.json"' });
    return res.json(data);
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'EXPORT_FAILED', error.message);
  }
});
app.post('/api/import', async (req, res) => {
  try {
    return res.json(await productRuntime.importProductState(req));
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'IMPORT_FAILED', error.message);
  }
});
app.get('/api/deletions', (_, res) => res.json(state.deletionRecords || []));
app.delete('/api/account', async (req, res) => {
  try {
    return res.json(await productRuntime.deleteAccount(req));
  } catch (error) {
    return fail(res, error.status || 503, error.code || 'ACCOUNT_DELETE_FAILED', error.message);
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
  const compatibility = compatibilityMemoryForRequest(req);
  const results = await Promise.all(ids.map(id => compatibility.revoke(id)));
  res.json({ requested: ids.length, revoked: results.filter(Boolean).length, memories: results.filter(Boolean) });
});
app.get('/api/confirmations', async (req, res) => {
  try {
    return res.json(await compatibilityMemoryForRequest(req).listConfirmations(req.query || {}));
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'INVALID_CONFIRMATIONS_QUERY', error.message);
  }
});
app.post('/api/confirmations/:id/confirm', async (req, res) => {
  try {
    const result = await compatibilityMemoryForRequest(req).confirm(req.params.id, apiMemoryMutationInput(req));
    return res.json(result);
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_CONFIRMATION_FAILED', error.message);
  }
});
app.post('/api/confirmations/:id/reject', async (req, res) => {
  try {
    const result = await compatibilityMemoryForRequest(req).reject(req.params.id, apiMemoryMutationInput(req));
    return res.json(result);
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_CONFIRMATION_FAILED', error.message);
  }
});
app.post('/api/memories/:id/promote', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).promote(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_PROMOTE_FAILED', error.message);
  }
});
app.post('/api/memories/:id/pin', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).pin(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_PIN_FAILED', error.message);
  }
});
app.post('/api/memories/:id/unpin', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).unpin(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_UNPIN_FAILED', error.message);
  }
});
app.post('/api/memories/:id/forget', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).forget(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_FORGET_FAILED', error.message);
  }
});
app.post('/api/memories/:id/revoke', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).revoke(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_REVOKE_FAILED', error.message);
  }
});
app.get('/api/memories/:id', async (req, res) => { const item = await compatibilityMemoryForRequest(req).get(req.params.id); item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found'); });
app.patch('/api/memories/:id', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).update(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'INVALID_MEMORY', error.message);
  }
});
app.post('/api/memories/:id/correct', async (req, res) => {
  try {
    const item = await compatibilityMemoryForRequest(req).update(req.params.id, apiMemoryMutationInput(req));
    return item ? res.json(item) : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'INVALID_MEMORY', error.message);
  }
});
app.delete('/api/memories/:id', async (req, res) => {
  try {
    const removed = await compatibilityMemoryForRequest(req).remove(req.params.id, apiMemoryMutationInput(req));
    return removed ? res.status(204).end() : fail(res, 404, 'MEMORY_NOT_FOUND', 'Memory not found');
  } catch (error) {
    return fail(res, error.status || 400, error.code || 'MEMORY_DELETE_FAILED', error.message);
  }
});
app.get('/api/memory/overview', async (req, res) => {
  try {
    const { memories } = await chatMemoryForRequest(req).overview();
    res.json({ count: memories.length, memories: memories.slice(0, 8), memorySystem: 'memory-module' });
  } catch (error) {
    fail(res, error.status || 503, error.code || 'MEMORY_MODULE_UNAVAILABLE', error.message || 'Memory Module unavailable');
  }
});
app.post('/api/models/:provider/test', async (req, res) => {
  const provider = String(req.params.provider || '').trim();
  const requestedModel = String(req.body?.model || '').trim();
  const selection = resolveModelSelection(provider, requestedModel);
  if (!selection.ok) return fail(res, ['MODEL_NOT_CONFIGURED', 'MODEL_EXTERNAL_POLICY_REQUIRED'].includes(selection.code) ? 503 : 400, selection.code, selection.error);
  const selected = createCompanionModelGateway(provider, { model: selection.config.model });
  const startedAt = Date.now();
  try {
    await selected.generate({ message: 'Connection test. Reply with OK.', recalled: [] });
    res.json({ ok: true, provider: selected.provider, model: selected.model, protocol: selected.protocol, latencyMs: Date.now() - startedAt });
  } catch (error) {
    fail(res, error.code === 'MODEL_AUTH_FAILED' ? 401 : error.code === 'MODEL_INSUFFICIENT_BALANCE' ? 402 : error.code === 'MODEL_NOT_FOUND' ? 404 : error.code === 'MODEL_TIMEOUT' ? 504 : 502, error.code || 'MODEL_CONNECTION_FAILED', error.message);
  }
});
app.post('/api/chat/cancel', chatController.cancelChat);
app.get('/api/chat/stream/:runId', chatController.reconnectChatStream);
app.get('/api/memory/dream', async (req, res) => res.json({ memories: await compatibilityMemoryForRequest(req).dream(req.query.limit), generatedAt: new Date().toISOString() }));
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
app.get('/api/mode', (_, res) => res.json({ mode: state.mode }));
app.patch('/api/mode', async (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['companion', 'work'].includes(mode)) return fail(res, 400, 'INVALID_MODE', 'Mode must be companion or work');
  state.mode = mode;
  await saveState(state);
  res.json({ mode: state.mode });
});
app.post('/api/chat/approve', chatController.approveToolCall);
// 文件上传：手机/网页上传文件到服务端，供工作模式 read 工具处理
app.post('/api/upload', async (req, res) => {
  const userId = currentUserId();
  const previousUploads = structuredClone(state.uploads || []);
  let record = null;
  try {
    const { name, dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') return fail(res, 400, 'INVALID_UPLOAD', 'dataUrl is required');
    record = await uploadStore.save({ userId, name, dataUrl, storageKey: ensureUploadOwnerKey(state), existingRecords: state.uploads || [] });
    state.uploads ||= [];
    state.uploads.unshift(record);
    await saveState(state);
    return res.json(record);
  } catch (error) {
    if (record) {
      state.uploads = previousUploads;
      await uploadStore.removeRecord(record).catch(cleanupError => {
        console.error(JSON.stringify({ event: 'upload_write_rollback_failed', code: cleanupError.code || 'UPLOAD_ROLLBACK_FAILED' }));
      });
    }
    return fail(res, error.status || 400, error.code || 'UPLOAD_FAILED', error.message);
  }
});
app.get('/api/personality', (_, res) => res.json({ ...state.personality, evidenceCount: state.evidence.length }));
app.get('/api/personality/history', (_, res) => res.json(state.personalityHistory.map(version => ({
  version: version.version,
  traits: version.traits,
  summary: version.summary,
  updatedAt: version.updatedAt,
  sourceEvidenceId: version.sourceEvidenceId || null,
  sourceEventId: version.sourceEventId || null,
  sourceAssertionVersionId: version.sourceAssertionVersionId || null,
  previousVersion: version.previousVersion || null
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
app.get('/api/growth/evidence/:id', async (req, res) => { const item = growthEvidence.trace(req.params.id); item ? res.json(item) : fail(res, 404, 'EVIDENCE_NOT_FOUND', 'Evidence not found'); });
const reviewEvidence = async (item, status, previousStatus = item.status) => {
  const previousEvidence = structuredClone(item);
  const previousProjection = {
    personality: structuredClone(state.personality),
    history: structuredClone(state.personalityHistory),
    audit: structuredClone(state.personalityAudit),
    projection: structuredClone(state.personalityProjection)
  };
  const updated = await growthEvidence.updateEvidence(item.id, status, { persist: false });
  try {
    if (status === 'confirmed' && previousStatus !== 'confirmed') {
      await personalityProjection.applyConfirmedEvidence(updated);
    }
    await saveState(state);
  } catch (error) {
    Object.assign(item, previousEvidence);
    state.personality = previousProjection.personality;
    state.personalityHistory = previousProjection.history;
    state.personalityAudit = previousProjection.audit;
    state.personalityProjection = previousProjection.projection;
    await saveState(state).catch(() => {});
    throw error;
  }
  return updated;
};
app.patch('/api/growth/evidence/:id', async (req, res) => {
  try {
    const requestedStatus = req.body?.status === 'approved' ? 'confirmed' : req.body?.status;
    const previous = growthEvidence.trace(req.params.id);
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
  try {
    const result = await personalityProjection.rollback(req.body?.version, {
      expectedRevision: req.body?.expectedRevision ?? req.body?.resourceRevision,
      source: req.body?.source || 'user'
    });
    await saveState(state);
    res.json({ ...result.personality, audit: result.audit });
  } catch (error) {
    fail(res, error.status || 400, error.code || 'PERSONALITY_ROLLBACK_FAILED', error.message);
  }
});

app.post('/api/chat/stream', (req, res) => chatController.handleChatStream(req, res));
app.post('/api/chat/regenerate', (req, res) => chatController.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null }));
app.post('/api/chat/retry', (req, res) => chatController.handleChatStream(req, res, { regenerateMessageId: String(req.body?.messageId || '').trim() || null, retry: true }));
app.post('/api/chat/group', chatController.handleGroupChat);
const collectMcpWriteRequest = createMcpWriteIngress({ collector: interactionCollector });

app.post('/mcp', async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  try {
    const compatibility = compatibilityMemoryForRequest(req);
    let result;
    if (method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'cochpia-memory', version: '0.1.0' }, capabilities: { tools: {} } };
    else if (method === 'notifications/initialized') return res.status(202).end();
    else if (method === 'tools/list') result = { tools: compatibility.listTools().concat(['grow', 'trace']).map(name => ({ name, description: `Cochpia memory tool: ${name}` })) };
    else if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      assertMcpWriteAuthorized({ name, providedToken: req.get('x-mcp-service-token') });
      if (productRuntime.isAccountDeletionInProgress(currentUserId()) && ['hold', 'grow'].includes(name)) {
        throw Object.assign(new Error('Account deletion is in progress'), { code: 'ACCOUNT_DELETE_IN_PROGRESS', status: 409 });
      }
      if (name === 'breath') result = { content: [{ type: 'text', text: JSON.stringify(await compatibility.breath(args.query, args.limit)) }] };
      else if (name === 'hold') {
        const ingress = await collectMcpWriteRequest({ request: req, id, name, args });
        const writeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        result = { content: [{ type: 'text', text: JSON.stringify(await compatibility.hold({
          ...writeArgs,
          idempotency_key: writeArgs.idempotency_key || writeArgs.idempotencyKey || ingress.envelope?.idempotency_key,
          sourceEventId: ingress.rawEventId || null
        })) }] };
      }
      else if (name === 'dream') result = { content: [{ type: 'text', text: JSON.stringify(await compatibility.dream(args.limit)) }] };
      else if (name === 'grow') {
        const ingress = await collectMcpWriteRequest({ request: req, id, name, args });
        const writeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const evidenceInput = { ...writeArgs, sourceEventId: ingress.rawEventId || writeArgs.sourceEventId || null };
        const evidence = writeArgs.storage_directive === 'do_not_store'
          ? { status: 'accepted_no_store' }
          : ingress.rawEventId
          ? await growthEvidence.growFromSourceEvent(ingress.rawEventId, evidenceInput)
          : await growthEvidence.grow(evidenceInput);
        result = { content: [{ type: 'text', text: JSON.stringify(evidence) }] };
      }
      else if (name === 'trace') result = { content: [{ type: 'text', text: JSON.stringify(growthEvidence.trace(args.id)) }] };
      else result = { content: [{ type: 'text', text: JSON.stringify({ error: 'Unknown tool' }) }], isError: true };
    } else throw new Error(`Unsupported method: ${method}`);
    res.json({ jsonrpc: '2.0', id, result });
  } catch (error) { res.status(error.status || 500).json({ jsonrpc: '2.0', id, error: { code: error.code || -32000, message: error.message } }); }
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
