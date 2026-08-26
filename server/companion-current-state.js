const DEFAULT_CURRENT_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_CURRENT_STATE_TTL_MS = 60 * 1000;
const MAX_CURRENT_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 240;

function nowDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError('Companion current state now must be a valid date');
  return date;
}

function jsonClone(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const cloned = structuredClone(value);
    JSON.stringify(cloned);
    return cloned;
  } catch {
    return null;
  }
}

function safeText(value, max = MAX_TEXT_LENGTH) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function positiveRevision(value, fallback = 1) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : fallback;
}

function validIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEmotion(value) {
  const emotion = jsonClone(value);
  if (!emotion) return null;
  const valence = Number.isFinite(Number(emotion.valence)) ? Number(emotion.valence) : 0;
  const arousal = Number.isFinite(Number(emotion.arousal)) ? Number(emotion.arousal) : 0;
  return {
    label: safeText(emotion.label, 80) || '中性',
    valence: Math.max(-1, Math.min(1, valence)),
    arousal: Math.max(0, Math.min(1, arousal)),
    signals: Array.isArray(emotion.signals) ? emotion.signals.map(signal => safeText(signal, 80)).filter(Boolean).slice(0, 8) : []
  };
}

export function resolveCompanionCurrentStateTtl(ttlMs = process.env.COMPANION_CURRENT_STATE_TTL_MS) {
  const candidate = Number(ttlMs ?? DEFAULT_CURRENT_STATE_TTL_MS);
  if (!Number.isFinite(candidate) || candidate <= 0) return DEFAULT_CURRENT_STATE_TTL_MS;
  return Math.min(MAX_CURRENT_STATE_TTL_MS, Math.max(MIN_CURRENT_STATE_TTL_MS, Math.floor(candidate)));
}

function normalizeState(value, { now, ttlMs } = {}) {
  const source = jsonClone(value);
  if (!source) return null;
  const clock = nowDate(now);
  const ttl = resolveCompanionCurrentStateTtl(ttlMs);
  const updatedAt = validIso(source.updatedAt) || clock.toISOString();
  const expiresAt = validIso(source.expiresAt)
    || new Date(new Date(updatedAt).getTime() + ttl).toISOString();
  if (new Date(expiresAt).getTime() <= clock.getTime()) return null;
  return {
    schemaVersion: 1,
    currentTopic: safeText(source.currentTopic),
    currentIntent: safeText(source.currentIntent, 80) || 'casual',
    currentNeed: safeText(source.currentNeed, 80) || 'conversation',
    currentEmotion: normalizeEmotion(source.currentEmotion),
    lastUserMessageId: safeText(source.lastUserMessageId),
    lastAssistantMessageId: safeText(source.lastAssistantMessageId),
    sourceEventId: safeText(source.sourceEventId),
    resourceRevision: positiveRevision(source.resourceRevision),
    updatedAt,
    expiresAt
  };
}

export function getCompanionCurrentState(session, { now = new Date(), ttlMs } = {}) {
  return normalizeState(session?.currentState, { now, ttlMs });
}

export function snapshotCompanionCurrentState(session) {
  return jsonClone(session?.currentState);
}

export function restoreCompanionCurrentState(session, snapshot) {
  if (!session || typeof session !== 'object') throw new TypeError('Companion current state session is required');
  const restored = jsonClone(snapshot);
  if (restored) session.currentState = restored;
  else delete session.currentState;
  return restored;
}

export function updateCompanionCurrentState(session, {
  turn,
  userMessageId = null,
  assistantMessageId = null,
  sourceEventId = null,
  now = new Date(),
  ttlMs
} = {}) {
  if (!session || typeof session !== 'object') throw new TypeError('Companion current state session is required');
  if (!turn || typeof turn !== 'object') throw new TypeError('Companion current state turn is required');
  const clock = nowDate(now);
  const ttl = resolveCompanionCurrentStateTtl(ttlMs);
  const previous = getCompanionCurrentState(session, { now: clock, ttlMs: ttl });
  const topics = Array.isArray(turn.topics) ? turn.topics : [];
  const previousRevision = previous?.resourceRevision || positiveRevision(session.currentState?.resourceRevision, 0);
  const next = {
    schemaVersion: 1,
    currentTopic: safeText(topics[0]) || previous?.currentTopic || null,
    currentIntent: safeText(turn.intent, 80) || previous?.currentIntent || 'casual',
    currentNeed: safeText(turn.explicitNeed, 80) || previous?.currentNeed || 'conversation',
    currentEmotion: turn.emotion ? normalizeEmotion(turn.emotion) : null,
    lastUserMessageId: safeText(userMessageId) || previous?.lastUserMessageId || null,
    lastAssistantMessageId: safeText(assistantMessageId) || previous?.lastAssistantMessageId || null,
    sourceEventId: safeText(sourceEventId),
    resourceRevision: Math.min(Number.MAX_SAFE_INTEGER, previousRevision + 1),
    updatedAt: clock.toISOString(),
    expiresAt: new Date(clock.getTime() + ttl).toISOString()
  };
  session.currentState = next;
  return next;
}

export {
  DEFAULT_CURRENT_STATE_TTL_MS,
  MIN_CURRENT_STATE_TTL_MS,
  MAX_CURRENT_STATE_TTL_MS
};
