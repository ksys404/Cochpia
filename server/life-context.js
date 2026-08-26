const clone = value => value == null ? value : structuredClone(value);

function relationshipContext(record = {}) {
  return {
    id: record.id || null,
    agentId: record.agentId || null,
    stage: record.stage || null,
    score: Number(record.score) || 0,
    interactionCount: Number(record.interactionCount) || 0,
    resourceRevision: Number(record.resourceRevision) || 1,
    updatedAt: record.updatedAt || null,
    signals: (record.signals || []).slice(0, 20).map(signal => ({
      signalType: signal.signalType || null,
      delta: Number(signal.delta) || 0,
      evidence: String(signal.evidence || '').slice(0, 300),
      occurredAt: signal.occurredAt || null
    }))
  };
}

function currentStateContext(lifeState = {}) {
  return {
    day: lifeState.day,
    timeOfDay: lifeState.timeOfDay,
    mode: lifeState.mode,
    location: lifeState.location,
    needs: clone(lifeState.needs || {}),
    lastAction: lifeState.lastAction || null,
    currentEvent: lifeState.currentEvent ? {
      day: lifeState.currentEvent.day,
      timeOfDay: lifeState.currentEvent.timeOfDay,
      place: lifeState.currentEvent.place,
      text: String(lifeState.currentEvent.text || '').slice(0, 1000),
      occurredAt: lifeState.currentEvent.occurredAt || null
    } : null,
    pendingDecision: lifeState.pendingDecision ? {
      title: String(lifeState.pendingDecision.title || '').slice(0, 300),
      prompt: String(lifeState.pendingDecision.prompt || '').slice(0, 600),
      options: (lifeState.pendingDecision.options || []).slice(0, 8).map(option => ({
        id: option.id,
        label: String(option.label || '').slice(0, 160)
      }))
    } : null
  };
}

function memoryItemForClient(item = {}) {
  return {
    content: String(item.content ?? item.summary ?? item.value ?? '').slice(0, 1200),
    memoryType: item.memoryType || item.memory_type || 'memory',
    assertionType: item.assertionType || item.assertion_type || null,
    scope: item.scope ? { type: item.scope.type || null, agentId: item.scope.agentId || null } : null,
    sensitivity: item.sensitivity || null,
    confidence: Number(item.confidence) || 0,
    importance: Number(item.importance) || 0,
    mentionPolicy: item.mentionPolicy || null,
    directQueryPolicy: item.directQueryPolicy || null,
    pinned: Boolean(item.pinned)
  };
}

function sanitizeMemoryBundleForClient(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const next = {
    answerability: bundle.answerability || 'not_found',
    consistency: bundle.consistency || 'unknown',
    serviceMode: bundle.serviceMode || 'normal',
    queryRoute: bundle.queryRoute || 'unknown',
    policyResult: bundle.policyResult || 'unknown',
    coreMemory: (bundle.coreMemory || []).map(memoryItemForClient),
    userProfile: (bundle.userProfile || []).map(memoryItemForClient),
    relationshipProfile: (bundle.relationshipProfile || []).map(memoryItemForClient),
    currentState: (bundle.currentState || []).map(memoryItemForClient),
    relevantEpisodes: (bundle.relevantEpisodes || []).map(episode => ({
      title: String(episode.title || '').slice(0, 300),
      summary: String(episode.summary || '').slice(0, 1200),
      observedStart: episode.observedStart || null,
      observedEnd: episode.observedEnd || null,
      status: episode.status || null
    })),
    uncertainties: (bundle.uncertainties || []).map(item => ({
      canonicalKey: item.canonicalKey || null,
      values: Array.isArray(item.values) ? item.values.map(value => String(value).slice(0, 500)) : []
    })),
    blocks: (bundle.blocks || []).map(block => ({ type: block.type || 'policy_block' })),
    tokenBudget: bundle.tokenBudget || null,
    tokenCount: bundle.tokenCount || null,
    truncated: Boolean(bundle.truncated)
  };
  return next;
}

export function buildLifeCompanionContext({
  contextBuilder,
  identity,
  session = null,
  personality = null,
  relationship = null,
  lifeState = null,
  memoryBundle = null,
  profile = null,
  mode = null,
  boundaries = {},
  upcomingEvents = [],
  tokenBudget = 1200
} = {}) {
  if (!contextBuilder?.build) throw new TypeError('Life context requires a Context Builder');
  return contextBuilder.build({
    tokenBudget,
    identity: clone(identity),
    session: clone(session),
    personality: clone(personality),
    relationship: relationshipContext(relationship || {}),
    currentState: currentStateContext(lifeState || {}),
    memoryBundle: sanitizeMemoryBundleForClient(memoryBundle),
    profile: clone(profile),
    mode,
    upcomingEvents: clone(upcomingEvents),
    boundaries: { ...clone(boundaries || {}), source: 'life-state', memoryPurpose: 'profile_view' }
  });
}

export { currentStateContext, relationshipContext, sanitizeMemoryBundleForClient };
