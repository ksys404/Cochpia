function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return { at: '', id: '' };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('invalid');
    if (parsed.at && Number.isNaN(new Date(parsed.at).getTime())) throw new Error('invalid');
    return parsed;
  } catch {
    throw new Error('Invalid sync cursor');
  }
}

function compareRecord(record, cursor) {
  const time = new Date(record.updatedAt).getTime();
  const cursorTime = cursor.at ? new Date(cursor.at).getTime() : -Infinity;
  return time - cursorTime || record.id.localeCompare(cursor.id);
}

export function collectSyncChanges(state, { cursor, limit = 100 } = {}) {
  const decoded = decodeCursor(cursor);
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  const records = [];
  const add = (entity, id, data, timestamp) => records.push({ entity, id: String(id), updatedAt: timestamp || new Date(0).toISOString(), data: structuredClone(data) });

  for (const session of state.sessions || []) add('session', session.id, session, session.updatedAt || session.createdAt);
  for (const [sessionId, messages] of Object.entries(state.messages || {})) {
    for (const message of messages || []) add('message', `${sessionId}:${message.id}`, { ...message, sessionId }, message.updatedAt || message.createdAt);
  }
  for (const memory of state.memories || []) add('memory', memory.id, memory, memory.updatedAt || memory.createdAt);
  for (const task of state.tasks || []) add('task', task.id, task, task.updatedAt || task.createdAt);
  for (const evidence of state.evidence || []) add('evidence', evidence.id, evidence, evidence.updatedAt || evidence.createdAt);
  for (const audit of state.personalityAudit || []) add('personality_audit', audit.id, audit, audit.createdAt);
  if (state.personality?.updatedAt) add('personality', 'current', state.personality, state.personality.updatedAt);

  records.sort((a, b) => compareRecord(a, b));
  const changed = records.filter(record => compareRecord(record, decoded) > 0);
  const page = changed.slice(0, safeLimit);
  const hasMore = changed.length > page.length;
  const last = page.at(-1);
  const nextCursor = encodeCursor(last ? { at: last.updatedAt, id: last.id } : { at: new Date().toISOString(), id: '~' });
  return { changes: page, nextCursor, hasMore, limit: safeLimit };
}

export { decodeCursor, encodeCursor };
