import { buildRuntimeContext } from './runtime-context.js';

const DEFAULT_TOKEN_BUDGET = 4_000;
const MIN_TOKEN_BUDGET = 256;
const CHARS_PER_TOKEN = 4;
const MAX_MESSAGES = 20;
const MAX_RECALLED = 24;
const MAX_AUXILIARY_RECORD_CHARS = 6_000;
const MEMORY_BUNDLE_FALLBACK = {
  answerability: 'not_found',
  consistency: 'unknown',
  policyResult: 'unknown'
};

const safeText = (value, max = 4_000) => String(value ?? '').slice(0, max);
const safeRecord = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const cloned = structuredClone(value);
    return JSON.stringify(cloned).length <= MAX_AUXILIARY_RECORD_CHARS ? cloned : { truncated: true };
  } catch {
    return { truncated: true };
  }
};

function estimateTokens(value) {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

function trimBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  try {
    const next = structuredClone(bundle);
    for (const key of ['coreMemory', 'userProfile', 'relationshipProfile', 'currentState', 'relevantEpisodes']) {
      if (Array.isArray(next[key])) next[key] = next[key].slice(0, MAX_RECALLED);
    }
    return next;
  } catch {
    return { ...MEMORY_BUNDLE_FALLBACK };
  }
}

function buildOnce(input = {}) {
  const memoryBundle = trimBundle(input.memoryBundle);
  const base = buildRuntimeContext({
    messages: (input.messages || []).slice(-MAX_MESSAGES).map(message => ({
      ...message,
      content: safeText(message.content, 4_000)
    })),
    personality: input.personality,
    recalled: (input.recalled || []).slice(0, MAX_RECALLED).map(memory => ({
      ...memory,
      summary: safeText(memory.summary, 1_200)
    })),
    memoryBundle,
    summary: safeText(input.summary, 4_000),
    persona: safeText(input.persona, 4_000),
    upcomingEvents: input.upcomingEvents,
    atmosphere: safeText(input.atmosphere, 500),
    profile: input.profile,
    mode: input.mode,
    currentState: input.currentState,
    turn: input.turn,
    responsePlan: input.responsePlan,
    policy: input.policy
  });
  const currentState = safeRecord(input.currentState || input.current_state) || base.currentState;
  return {
    schemaVersion: 1,
    identity: {
      tenantId: input.identity?.tenantId || input.identity?.tenant_id || null,
      userId: input.identity?.userId || input.identity?.subjectUserId || input.identity?.subject_user_id || null,
      actorType: input.identity?.actorType || input.identity?.actor_type || 'user',
      agentId: input.identity?.agentId || input.identity?.callerAgentId || input.identity?.caller_agent_id || null,
      relationshipId: input.identity?.relationshipId || input.identity?.relationship_id || null,
      sessionId: input.identity?.sessionId || input.identity?.session_id || null
    },
    relationship: safeRecord(input.relationship),
    session: safeRecord(input.session),
    boundaries: safeRecord(input.boundaries) || {},
    ...base,
    currentState,
    memoryBundle
  };
}

function compactToBudget(context, tokenBudget) {
  const maxChars = Math.max(512, tokenBudget * CHARS_PER_TOKEN - 160);
  let truncated = false;
  const size = () => JSON.stringify(context).length;
  while (size() > maxChars && context.messages.length > 1) {
    context.messages.shift();
    truncated = true;
  }
  while (size() > maxChars && context.recalled.length) {
    context.recalled.pop();
    truncated = true;
  }
  const bundleArrays = ['coreMemory', 'userProfile', 'relationshipProfile', 'currentState', 'relevantEpisodes'];
  while (size() > maxChars && context.memoryBundle) {
    const key = bundleArrays.find(name => Array.isArray(context.memoryBundle[name]) && context.memoryBundle[name].length);
    if (!key) break;
    context.memoryBundle[key].pop();
    truncated = true;
  }
  while (size() > maxChars && context.messages.length) {
    const target = context.messages.reduce((longest, message, index) => message.content.length > context.messages[longest].content.length ? index : longest, 0);
    const content = context.messages[target].content;
    if (content.length <= 240) break;
    context.messages[target].content = content.slice(0, Math.max(240, Math.floor(content.length * 0.7)));
    truncated = true;
  }
  if (size() > maxChars && context.memoryBundle) {
    context.memoryBundle = {
      answerability: context.memoryBundle.answerability || 'not_found',
      consistency: context.memoryBundle.consistency || 'unknown',
      policyResult: context.memoryBundle.policyResult || 'unknown'
    };
    truncated = true;
  }
  for (const field of ['summary', 'persona']) {
    while (size() > maxChars && context[field].length > 240) {
      context[field] = context[field].slice(0, Math.max(240, Math.floor(context[field].length * 0.7)));
      truncated = true;
    }
  }
  if (size() > maxChars && context.currentState) context.currentState = { truncated: true };
  if (size() > maxChars && context.policy) context.policy = { truncated: true };
  if (size() > maxChars && context.turn) {
    context.turn = {
      schemaVersion: context.turn.schemaVersion,
      messageId: context.turn.messageId || null,
      intent: context.turn.intent || 'casual',
      explicitNeed: context.turn.explicitNeed || 'conversation',
      emotion: context.turn.emotion ? {
        label: context.turn.emotion.label || '中性',
        valence: context.turn.emotion.valence || 0,
        arousal: context.turn.emotion.arousal || 0
      } : null,
      topics: Array.isArray(context.turn.topics) ? context.turn.topics.slice(0, 3) : []
    };
  }
  if (size() > maxChars && context.responsePlan) {
    context.responsePlan = {
      schemaVersion: context.responsePlan.schemaVersion,
      mode: context.responsePlan.mode || 'reflect_and_continue',
      goals: Array.isArray(context.responsePlan.goals) ? context.responsePlan.goals.slice(0, 2) : [],
      askQuestion: Boolean(context.responsePlan.askQuestion),
      maxQuestions: Number(context.responsePlan.maxQuestions) || 0,
      mentionMemory: Boolean(context.responsePlan.mentionMemory),
      memoryAnswerability: context.responsePlan.memoryAnswerability || 'unknown',
      targetLength: context.responsePlan.targetLength || 'short_to_medium'
    };
  }
  const result = { ...context, budget: { requestedTokens: tokenBudget, estimatedTokens: 0, truncated } };
  result.budget.estimatedTokens = estimateTokens(result);
  if (result.budget.estimatedTokens > tokenBudget) {
    throw Object.assign(
      new Error('Context token budget is too small to preserve the runtime context envelope'),
      { code: 'CONTEXT_TOKEN_BUDGET_TOO_SMALL', status: 400, tokenBudget, estimatedTokens: result.budget.estimatedTokens }
    );
  }
  return result;
}

export function buildCompanionContext(input = {}) {
  const numericBudget = Number(input.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const tokenBudget = Number.isFinite(numericBudget) ? Math.max(MIN_TOKEN_BUDGET, Math.floor(numericBudget)) : DEFAULT_TOKEN_BUDGET;
  return compactToBudget(buildOnce(input), tokenBudget);
}

export function createContextBuilder({ defaultTokenBudget = DEFAULT_TOKEN_BUDGET } = {}) {
  return {
    build(input = {}) {
      return buildCompanionContext({ tokenBudget: input.tokenBudget ?? defaultTokenBudget, ...input });
    }
  };
}

export { DEFAULT_TOKEN_BUDGET };
