const uniqueItems = items => {
  const seen = new Set();
  return items.filter(item => {
    const key = item.id || item.memoryId || item.episodeId || `${item.type}:${item.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

function addMemoryItem(items, item, { type = null, summary = null } = {}) {
  const content = summary || item?.content || item?.value || item?.summary || '';
  if (!String(content).trim()) return;
  items.push({
    id: item.memoryId || item.id || item.episodeId,
    type: type || item.memoryType || item.type || 'memory',
    summary: String(content).slice(0, 1200),
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.7,
    source: 'memory-module',
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
    sensitivity: item.sensitivity || null,
    sourceRefs: item.sourceRefs || []
  });
}

export function memoryBundleToRecalled(bundle = {}) {
  const items = [];
  for (const item of bundle.coreMemory || []) addMemoryItem(items, item, { type: 'core' });
  for (const item of bundle.userProfile || []) addMemoryItem(items, item, { type: item.memoryType || 'profile' });
  for (const item of bundle.relationshipProfile || []) addMemoryItem(items, item, { type: 'relationship' });
  for (const item of bundle.currentState || []) addMemoryItem(items, item, { type: 'current_state', summary: item.content || item.value });
  for (const item of bundle.relevantEpisodes || []) addMemoryItem(items, item, { type: 'episode', summary: item.summary || item.title });
  return uniqueItems(items);
}

export function memoryBundleToOverview(bundle = {}) {
  return memoryBundleToRecalled(bundle).map(item => ({
    id: item.id,
    type: item.type === 'profile' ? 'fact' : item.type,
    summary: item.summary,
    confidence: item.confidence,
    source: item.source,
    visibility: 'policy-controlled',
    strength: 1,
    importance: 0.5,
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  }));
}

export function inferChatMemoryType(text) {
  const value = String(text || '');
  if (/(喜欢|不喜欢|偏好|习惯|爱喝|爱吃|常用|prefer|like|dislike)/i.test(value)) return 'preference';
  if (/(计划|打算|想要|希望|目标|决定|以后|准备|plan|goal|want)/i.test(value)) return 'goal';
  if (/(我们|一起|共同|称呼|关系|相处)/.test(value)) return 'relationship';
  return 'fact';
}

export function createChatMemoryAdapter({ memoryModule, state, context, persistState = async () => {} } = {}) {
  if (!memoryModule || !state || !context) throw new TypeError('Memory Module chat adapter requires memoryModule, state, and context');

  const ensureLegacyImport = async () => {
    if (state.memoryModule?.legacyImportVersion === 1) {
      if (Array.isArray(state.memories)) {
        delete state.memories;
        await persistState();
      }
      return;
    }
    const legacy = Array.isArray(state.memories) ? state.memories.filter(item => !item.revokedAt && String(item.summary || '').trim()) : [];
    let failed = false;
    for (const item of legacy) {
      try {
        await memoryModule.hold(context, {
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
      await persistState();
    }
  };

  const retrieve = async query => {
    await ensureLegacyImport();
    const bundle = await memoryModule.contextBundleAsync(context, {
      query: String(query || '').slice(0, 1000),
      purpose: 'answer_user_query',
      tokenBudget: 1800
    });
    return { bundle, recalled: memoryBundleToRecalled(bundle) };
  };

  const overview = async () => {
    await ensureLegacyImport();
    const bundle = await memoryModule.contextBundleAsync(context, { purpose: 'profile_view', tokenBudget: 1200 });
    return { bundle, memories: memoryBundleToOverview(bundle) };
  };

  const recordTurn = async ({ eventId, content, eventRole, sourceRevision = '1', channel = '默认' } = {}) => {
    if (!String(content || '').trim()) return null;
    return memoryModule.recordEvent(context, {
      eventId,
      sourceRevision,
      content: String(content).slice(0, 12000),
      eventRole,
      contentType: 'plain_text',
      isStreamFinal: true,
      metadata: { channel: String(channel || '默认').slice(0, 200) }
    });
  };

  const remember = async ({ messageId, content, sourceEventId = null } = {}) => {
    if (!String(content || '').trim()) return null;
    return memoryModule.hold(context, {
      idempotency_key: `chat-memory:${messageId}`,
      content: String(content).slice(0, 4000),
      memoryType: inferChatMemoryType(content),
      assertionType: 'observed_fact',
      sensitivity: 'S0',
      confidence: 0.82,
      importance: 0.6,
      sourceEventId,
      promotionReason: 'chat_explicit_or_significant_message'
    });
  };

  return { ensureLegacyImport, retrieve, overview, recordTurn, remember };
}
