export const DEFAULT_CHAT_STREAM_JOURNAL_TTL_MS = 300_000;
export const DEFAULT_CHAT_STREAM_JOURNAL_MAX_EVENTS = 5_000;

const clone = value => value == null ? value : structuredClone(value);
const nowIso = value => new Date(value || Date.now()).toISOString();
const keyFor = (userId, runId) => `${String(userId || 'local-user')}:${String(runId || '')}`;

function pick(data, fields) {
  return Object.fromEntries(fields.filter(field => data?.[field] !== undefined).map(field => [field, clone(data[field])]));
}

export function sanitizeChatStreamEvent(entry) {
  if (!entry?.id || !entry?.event) return null;
  const data = entry.data || {};
  let safeData;
  if (entry.event === 'meta') safeData = pick(data, ['runId', 'messageId', 'protocol', 'provider', 'model', 'regeneratedFrom', 'retry', 'recalled']);
  else if (entry.event === 'text') safeData = { delta: String(data.delta || '').slice(0, 4_000) };
  else if (entry.event === 'error') safeData = pick(data, ['code', 'message']);
  else if (entry.event === 'done') safeData = pick(data, ['ok', 'cancelled', 'runId', 'messageId', 'memoryId', 'mode', 'engine', 'provider', 'model', 'personalityVersion', 'regeneratedFrom', 'retry']);
  else if (entry.event === 'tool') safeData = pick(data, ['runId', 'name']);
  else if (entry.event === 'tool_pending') safeData = pick(data, ['runId', 'toolCallId', 'name']);
  else if (entry.event === 'tool_result') safeData = { runId: data.runId, name: data.name, result: String(data.result || '').slice(0, 1_000) };
  else return null;
  return { id: String(entry.id), event: String(entry.event), data: safeData };
}

function recordFor({ userId, runId, sessionId, attempt, expiresAt, now }) {
  const timestamp = nowIso(now);
  return {
    userId: String(userId || 'local-user'),
    runId: String(runId),
    sessionId: String(sessionId || ''),
    attempt: Number.isSafeInteger(Number(attempt)) && Number(attempt) > 0 ? Number(attempt) : 1,
    state: 'streaming',
    events: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: nowIso(expiresAt || (new Date(timestamp).getTime() + DEFAULT_CHAT_STREAM_JOURNAL_TTL_MS))
  };
}

export function createChatStreamJournal({ storage = null, now = () => new Date(), retentionMs = DEFAULT_CHAT_STREAM_JOURNAL_TTL_MS, maxEvents = DEFAULT_CHAT_STREAM_JOURNAL_MAX_EVENTS } = {}) {
  const memory = new Map();
  const ttl = Math.max(30_000, Number(retentionMs) || DEFAULT_CHAT_STREAM_JOURNAL_TTL_MS);
  const limit = Math.max(100, Number(maxEvents) || DEFAULT_CHAT_STREAM_JOURNAL_MAX_EVENTS);

  const create = async ({ userId, runId, sessionId, attempt }) => {
    const record = recordFor({ userId, runId, sessionId, attempt, expiresAt: Date.now() + ttl, now: now() });
    memory.set(keyFor(userId, runId), record);
    if (storage?.create) await storage.create(clone(record));
    return clone(record);
  };

  const append = async ({ userId, runId, entry }) => {
    const safe = sanitizeChatStreamEvent(entry);
    if (!safe) return null;
    const key = keyFor(userId, runId);
    const record = memory.get(key);
    if (record && !record.events.some(item => item.id === safe.id)) {
      record.events.push(safe);
      if (record.events.length > limit) record.events.splice(0, record.events.length - limit);
      record.updatedAt = nowIso(now());
    }
    if (storage?.append) await storage.append({ userId, runId, entry: clone(safe), maxEvents: limit, updatedAt: nowIso(now()) });
    return clone(safe);
  };

  const finish = async ({ userId, runId, state = 'completed' }) => {
    const record = memory.get(keyFor(userId, runId));
    const expiresAt = nowIso(Date.now() + ttl);
    if (record) {
      record.state = String(state);
      record.expiresAt = expiresAt;
      record.updatedAt = nowIso(now());
    }
    if (storage?.finish) await storage.finish({ userId, runId, state: String(state), expiresAt, updatedAt: nowIso(now()) });
    return record ? clone(record) : null;
  };

  const load = async ({ userId, runId }) => {
    const persisted = storage?.load ? await storage.load({ userId, runId }) : null;
    if (persisted) {
      const normalized = clone(persisted);
      memory.set(keyFor(userId, runId), normalized);
      return normalized;
    }
    const record = memory.get(keyFor(userId, runId));
    if (!record || new Date(record.expiresAt).getTime() <= new Date(now()).getTime()) return null;
    return clone(record);
  };

  const remove = async ({ userId, runId = null, sessionId = null }) => {
    for (const [key, record] of memory) {
      if (String(record.userId) !== String(userId)) continue;
      if (runId && record.runId !== String(runId)) continue;
      if (sessionId && record.sessionId !== String(sessionId)) continue;
      memory.delete(key);
    }
    if (storage?.remove) await storage.remove({ userId, runId, sessionId });
  };

  const prune = async () => {
    const timestamp = new Date(now()).getTime();
    for (const [key, record] of memory) if (new Date(record.expiresAt).getTime() <= timestamp) memory.delete(key);
    if (storage?.prune) await storage.prune({ now: new Date(timestamp).toISOString() });
  };

  return { create, append, finish, load, remove, prune, sanitize: sanitizeChatStreamEvent };
}
