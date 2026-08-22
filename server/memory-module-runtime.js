import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleRouter } from './memory-module-api.js';
import { resolveMemoryFeatureFlags } from './memory-module-flags.js';
import { createChatMemoryAdapter } from './chat-memory.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

function asNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function toLegacyMemory(item, { revokedAt = null } = {}) {
  if (!item) return null;
  const status = item.status || 'active';
  const content = item.content ?? item.value ?? item.summary ?? '';
  return {
    id: item.memoryId || item.id,
    type: item.memoryType || item.type || 'fact',
    category: item.assertionType || item.category || item.memoryType || 'fact',
    summary: String(content).slice(0, 500),
    confidence: clamp(item.confidence ?? 0.7, 0, 1),
    source: 'memory-module',
    sourceEvent: item.sourceRefs?.[0] || null,
    visibility: status === 'revoked' || status === 'forgotten' ? 'revoked' : item.mentionPolicy === 'do_not_mention' ? 'private' : 'shared',
    strength: status === 'active' ? 1 : 0,
    valence: 0,
    arousal: 0.5,
    importance: clamp(item.importance ?? 0.5, 0, 1),
    metadata: { memoryId: item.memoryId || item.id, versionId: item.versionId || null, scope: item.scope || null },
    status,
    sensitivity: item.sensitivity || 'S0',
    resourceRevision: item.resourceRevision || 1,
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    ...(revokedAt ? { revokedAt } : {})
  };
}

function legacyInput(input = {}) {
  const content = String(input.content ?? input.summary ?? '').trim();
  return {
    ...input,
    content,
    memoryType: input.memoryType ?? input.memory_type ?? input.type ?? 'fact',
    sensitivity: input.sensitivity || 'S0',
    sourceEventId: input.sourceEventId ?? input.source_event ?? null,
    idempotency_key: input.idempotency_key || input.idempotencyKey || undefined
  };
}

export function createMemoryModuleRuntime({
  getState,
  persistState = async () => {},
  getUser = () => ({ id: 'local-user' }),
  featureFlags = resolveMemoryFeatureFlags(process.env),
  tenantId = process.env.MEMORY_TENANT_ID || 'local-tenant'
} = {}) {
  if (typeof getState !== 'function') throw new TypeError('Memory Module runtime requires getState');

  const instances = new WeakMap();
  const legacyImportPromises = new WeakMap();

  const stateForRequest = req => {
    const state = getState(req);
    if (!state || typeof state !== 'object') throw new TypeError('Memory Module runtime state is required');
    state.memoryModule ||= createMemoryModuleState();
    return state;
  };

  const contextFromRequest = (req, { chat = false } = {}) => {
    const user = getUser(req) || { id: 'local-user' };
    const allowDevelopmentAgentHeaders = process.env.NODE_ENV !== 'production' && process.env.MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS === 'true';
    const actorType = allowDevelopmentAgentHeaders ? (req.get('x-memory-actor-type') || 'user') : 'user';
    const callerAgentId = allowDevelopmentAgentHeaders ? (req.get('x-caller-agent-id') || req.get('x-agent-id') || 'cochpia') : 'cochpia';
    return {
      tenantId,
      subjectUserId: user.id,
      actorType,
      actorId: actorType === 'user' ? user.id : callerAgentId,
      callerAgentId,
      sessionId: chat ? null : req.body?.session_id || req.query?.session_id || null
    };
  };

  const moduleForRequest = req => {
    const state = stateForRequest(req);
    let module = instances.get(state);
    if (!module) {
      module = createMemoryModule(state.memoryModule, () => persistState(state), { featureFlags });
      instances.set(state, module);
    }
    return module;
  };

  const ensureLegacyImport = async (req, module, state, context) => {
    if (state.memoryModule.legacyImportVersion === 1) {
      if (Array.isArray(state.memories)) {
        delete state.memories;
        await persistState(state);
      }
      return;
    }
    if (legacyImportPromises.has(state)) return legacyImportPromises.get(state);
    const promise = (async () => {
      const legacy = Array.isArray(state.memories)
        ? state.memories.filter(item => !item.revokedAt && String(item.summary || '').trim())
        : [];
      let failed = false;
      for (const item of legacy) {
        try {
          await module.hold(context, {
            idempotency_key: `legacy-memory:${item.id}`,
            content: item.summary,
            memoryType: item.type || 'fact',
            sensitivity: 'S0',
            confidence: item.confidence,
            importance: item.importance,
            source: item.source || 'legacy-import',
            mentionPolicy: item.visibility === 'private' ? 'contextualizable_only' : 'mentionable'
          });
        } catch (error) {
          failed = true;
          console.error(JSON.stringify({ event: 'memory_legacy_import_failed', code: error.code || 'MEMORY_IMPORT_FAILED' }));
        }
      }
      if (!failed) {
        state.memoryModule.legacyImportVersion = 1;
        delete state.memories;
        await persistState(state);
      }
    })().finally(() => legacyImportPromises.delete(state));
    legacyImportPromises.set(state, promise);
    return promise;
  };

  const compatibilityForRequest = req => {
    const state = stateForRequest(req);
    const module = moduleForRequest(req);
    const context = contextFromRequest(req);
    const ensure = () => ensureLegacyImport(req, module, state, context);

    const getCurrent = async id => {
      await ensure();
      return module.get(context, id, { purpose: 'governance' });
    };

    return {
      listTools: () => ['breath', 'hold', 'dream'],
      async breath(query, limit = 5) {
        await ensure();
        const result = await module.retrieveAsync(context, { query: String(query || ''), purpose: 'answer_user_query', tokenBudget: 1800 });
        return result.items.slice(0, clamp(Number(limit) || 5, 1, 50)).map(item => ({ ...toLegacyMemory(item), score: item.score || 0 }));
      },
      async hold(input = {}) {
        await ensure();
        const normalized = legacyInput(input);
        if (!normalized.content) throw new Error('Memory summary is required');
        const result = await module.hold(context, normalized);
        return toLegacyMemory(result.memory || result.currentState);
      },
      async list(options = {}) {
        await ensure();
        const includeRevoked = options.includeRevoked === true || options.includeRevoked === 'true';
        const items = module.list(context, { ...options, purpose: includeRevoked ? 'governance' : 'profile_view', limit: options.limit || 100 });
        return items.map(item => toLegacyMemory(item));
      },
      async get(id) {
        const item = await getCurrent(id);
        return toLegacyMemory(item);
      },
      async update(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const result = await module.correct(context, id, {
          ...input,
          content: input.content ?? input.summary ?? current.content,
          resourceRevision: input.resourceRevision ?? current.resourceRevision,
          idempotency_key: input.idempotency_key || input.idempotencyKey || `legacy-correct:${id}:${current.resourceRevision}`
        });
        return toLegacyMemory(result.memory || result);
      },
      async remove(id) {
        const current = await getCurrent(id);
        if (!current) return false;
        await module.remove(context, id, { resourceRevision: current.resourceRevision, idempotency_key: `legacy-delete:${id}:${current.resourceRevision}` });
        return true;
      },
      async revoke(id) {
        const current = await getCurrent(id);
        if (!current) return null;
        const revokedAt = new Date().toISOString();
        await module.revoke(context, id, { resourceRevision: current.resourceRevision, idempotency_key: `legacy-revoke:${id}:${current.resourceRevision}` });
        return toLegacyMemory({ ...current, status: 'revoked' }, { revokedAt });
      },
      async exportMemories() {
        await ensure();
        return module.list(context, { purpose: 'governance', limit: 1000 }).map(item => toLegacyMemory(item));
      },
      async dream(limit = 5) {
        const items = await this.list({ limit });
        return items.slice(0, clamp(Number(limit) || 5, 1, 50));
      }
    };
  };

  return {
    moduleForRequest,
    contextFromRequest,
    async prepareForRequest(req) {
      const state = stateForRequest(req);
      const module = moduleForRequest(req);
      const context = contextFromRequest(req);
      await ensureLegacyImport(req, module, state, context);
      return module;
    },
    compatibilityForRequest,
    chatForRequest(req) {
      const state = stateForRequest(req);
      return createChatMemoryAdapter({
        memoryModule: moduleForRequest(req),
        state,
        context: contextFromRequest(req, { chat: true }),
        persistState: () => persistState(state)
      });
    },
    router() {
      return createMemoryModuleRouter({
        memoryModuleForRequest: req => this.prepareForRequest(req),
        contextFromRequest
      });
    }
  };
}

export { toLegacyMemory };
