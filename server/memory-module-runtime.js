import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleRouter } from './memory-module-api.js';
import { resolveMemoryFeatureFlags } from './memory-module-flags.js';
import { createChatMemoryAdapter } from './chat-memory.js';
import { buildIdentityRelationshipContext } from './identity-relationship-context.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

function asNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function toLegacyMemory(item, { revokedAt = null, contentOverride = undefined } = {}) {
  if (!item) return null;
  const status = item.status || 'active';
  const contentVisible = !['revoked', 'forgotten', 'deleted', 'rejected', 'expired', 'superseded'].includes(status);
  const content = contentOverride ?? (contentVisible ? item.content ?? item.value ?? item.summary ?? '' : '');
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
    pinned: Boolean(item.pinned),
    pinnedVersionId: item.pinnedVersionId || null,
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

function compatibilityMutationInput(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const idempotencyKey = value.idempotency_key || value.idempotencyKey;
  const resourceRevision = value.resource_revision ?? value.resourceRevision;
  if (idempotencyKey) value.idempotency_key = idempotencyKey;
  if (resourceRevision != null) value.resource_revision = resourceRevision;
  return value;
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

  const contextFromRequest = (req, { chat = false, sessionId = undefined } = {}) => {
    const user = getUser(req) || { id: 'local-user' };
    const allowDevelopmentAgentHeaders = process.env.NODE_ENV !== 'production' && process.env.MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS === 'true';
    const actorType = allowDevelopmentAgentHeaders ? (req.get('x-memory-actor-type') || 'user') : 'user';
    const callerAgentId = allowDevelopmentAgentHeaders ? (req.get('x-caller-agent-id') || req.get('x-agent-id') || 'cochpia') : 'cochpia';
    return buildIdentityRelationshipContext({
      tenantId,
      subjectUserId: user.id,
      actorType,
      actorId: actorType === 'user' ? user.id : callerAgentId,
      callerAgentId,
      sessionId: sessionId !== undefined ? sessionId : (chat ? null : req.body?.session_id || req.query?.session_id || null),
      requestId: req?.requestId || null,
      traceId: req?.traceId || null
    });
  };

  const moduleForRequest = req => {
    const state = stateForRequest(req);
    const memoryState = state.memoryModule;
    let module = instances.get(state);
    if (!module || module.state !== memoryState) {
      module = createMemoryModule(memoryState, () => persistState(state), { featureFlags });
      instances.set(state, module);
    }
    return module;
  };

  const ensureChatSession = async (req, applicationSessionId) => {
    const sessionId = String(applicationSessionId || '').trim().slice(0, 200);
    if (!sessionId) throw Object.assign(new Error('Application session id is required'), { code: 'SESSION_ID_REQUIRED', status: 400 });
    const state = stateForRequest(req);
    const module = moduleForRequest(req);
    const context = contextFromRequest(req, { chat: true });
    state.companion ||= {};
    state.companion.sessionMappings ||= {};
    const memorySessionId = String(state.companion.sessionMappings[sessionId] || sessionId).slice(0, 200);
    const existing = module.state.sessions.find(item => item.id === memorySessionId && item.tenantId === context.tenantId && item.userId === context.subjectUserId);
    if (existing && existing.status !== 'active') throw Object.assign(new Error('Memory session is not active'), { code: 'MEMORY_SESSION_NOT_ACTIVE', status: 409 });
    if (!existing) await module.createSession(context, { id: memorySessionId, callerAgentId: context.callerAgentId });
    if (state.companion.sessionMappings[sessionId] !== memorySessionId) {
      state.companion.sessionMappings[sessionId] = memorySessionId;
      await persistState(state);
    }
    return memorySessionId;
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

    const toCompatibilityMemory = item => {
      if (!item) return null;
      let contentOverride;
      if (!item.content && ['candidate', 'pending_confirmation'].includes(item.status)) {
        const assertion = module.state.assertions.find(candidate => candidate.id === item.memoryId);
        const version = assertion && module.state.assertionVersions.find(candidate => candidate.id === assertion.currentVersionId);
        contentOverride = version?.content;
      }
      return toLegacyMemory(item, { contentOverride });
    };

    const mutationInputFor = (input, { id, current = null, namespace } = {}) => {
      const value = compatibilityMutationInput(input);
      if (value.resource_revision == null && current?.resourceRevision != null) value.resource_revision = current.resourceRevision;
      if (!value.idempotency_key && value.resource_revision != null && id) {
        value.idempotency_key = `legacy-${namespace}:${id}:${value.resource_revision}`;
      }
      return value;
    };

    const mutationResult = (result, { fallback = null, contentOverride = undefined } = {}) => {
      if (!result || typeof result !== 'object') return result ?? fallback;
      const canonical = result.memory || result.currentState || (result.memoryId || result.id ? result : null);
      if (!canonical) return result;
      const legacy = toLegacyMemory(canonical, { contentOverride: contentOverride ?? (result.confirmation?.proposedContent && canonical.status === 'pending_confirmation' ? result.confirmation.proposedContent : undefined) });
      if (!legacy) return result;
      return {
        ...legacy,
        ...(result.status && result.status !== legacy.status ? { lifecycleStatus: result.status } : {}),
        ...(result.confirmation ? { confirmation: result.confirmation } : {}),
        ...(result.consistencyToken ? { consistencyToken: result.consistencyToken } : {}),
        ...(result.redactionEpoch != null ? { redactionEpoch: result.redactionEpoch } : {}),
        ...(result.deletionOperationId ? { deletionOperationId: result.deletionOperationId } : {})
      };
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
        return mutationResult(result);
      },
      async list(options = {}) {
        await ensure();
        const includeRevoked = options.includeRevoked === true || options.includeRevoked === 'true';
        const includeGovernance = includeRevoked
          || options.includeCandidates === true
          || options.includeCandidates === 'true'
          || options.status != null
          || options.purpose === 'governance';
        const items = module.list(context, { ...options, purpose: includeGovernance ? 'governance' : 'profile_view', limit: options.limit || 100 });
        return items.map(toCompatibilityMemory);
      },
      async get(id) {
        const item = await getCurrent(id);
        return toCompatibilityMemory(item);
      },
      async update(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const normalized = mutationInputFor(input, { id, current, namespace: 'correct' });
        const result = await module.correct(context, id, {
          ...normalized,
          content: input.content ?? input.summary ?? current.content
        });
        return mutationResult(result);
      },
      async promote(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const result = await module.promoteCandidate(context, id, mutationInputFor(input, { id, current, namespace: 'promote' }));
        return mutationResult(result);
      },
      async pin(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const result = await module.pin(context, id, mutationInputFor(input, { id, current, namespace: 'pin' }));
        return mutationResult(result);
      },
      async unpin(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const result = await module.unpin(context, id, mutationInputFor(input, { id, current, namespace: 'unpin' }));
        return mutationResult(result);
      },
      async forget(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const result = await module.forget(context, id, mutationInputFor(input, { id, current, namespace: 'forget' }));
        return mutationResult({ ...result, memory: { ...current, status: 'forgotten' } });
      },
      async confirm(id, input = {}) {
        await ensure();
        const result = await module.confirm(context, id, compatibilityMutationInput(input));
        return mutationResult(result);
      },
      async reject(id, input = {}) {
        await ensure();
        const result = await module.reject(context, id, compatibilityMutationInput(input));
        return mutationResult(result);
      },
      async listConfirmations(options = {}) {
        await ensure();
        return module.listConfirmations(context, { ...options, returnPage: options.returnPage !== false });
      },
      async remove(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return false;
        await module.remove(context, id, mutationInputFor(input, { id, current, namespace: 'delete' }));
        return true;
      },
      async revoke(id, input = {}) {
        const current = await getCurrent(id);
        if (!current) return null;
        const revokedAt = new Date().toISOString();
        const result = await module.revoke(context, id, mutationInputFor(input, { id, current, namespace: 'revoke' }));
        return { ...mutationResult({ ...result, memory: { ...current, status: 'revoked' } }), revokedAt };
      },
      async exportMemories() {
        await ensure();
        return module.list(context, { purpose: 'governance', limit: 1000 }).map(toCompatibilityMemory);
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
    ensureChatSession,
    async prepareForRequest(req) {
      const state = stateForRequest(req);
      const module = moduleForRequest(req);
      const context = contextFromRequest(req);
      await ensureLegacyImport(req, module, state, context);
      return module;
    },
    compatibilityForRequest,
    chatForRequest(req, sessionId = undefined) {
      const state = stateForRequest(req);
      return createChatMemoryAdapter({
        memoryModule: moduleForRequest(req),
        state,
        context: contextFromRequest(req, { chat: true, sessionId }),
        persistState: () => persistState(state)
      });
    },
    router(options = {}) {
      return createMemoryModuleRouter({
        memoryModuleForRequest: req => this.prepareForRequest(req),
        contextFromRequest,
        ...options
      });
    }
  };
}

export { toLegacyMemory };
