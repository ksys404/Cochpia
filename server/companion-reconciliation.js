const eventIdFor = (sessionId, messageId) => `chat:${sessionId}:${messageId}`;

const numericRevision = value => /^\d+$/.test(String(value ?? '').trim()) ? BigInt(String(value).trim()) : null;

function isNewerRevision(candidate, previous) {
  const candidateRevision = numericRevision(candidate?.sourceRevision);
  const previousRevision = numericRevision(previous?.sourceRevision);
  if (candidateRevision != null && previousRevision != null) return candidateRevision > previousRevision;
  if (candidateRevision != null && previousRevision == null) return true;
  if (candidateRevision == null && previousRevision != null) return false;
  return new Date(candidate?.createdAt || 0).getTime() >= new Date(previous?.createdAt || 0).getTime();
}

function latestChatEvents(events = []) {
  const latest = new Map();
  for (const event of events) {
    const key = event.eventId || event.id;
    if (!key) continue;
    const previous = latest.get(key);
    if (!previous || isNewerRevision(event, previous)) latest.set(key, event);
  }
  return [...latest.values()];
}

function expectedEvents(messages = [], sessionId) {
  return messages
    .filter(message => message && message.id && message.content && !(message.role === 'assistant' && String(message.id).startsWith('m-')))
    .map(message => ({
      eventId: eventIdFor(sessionId, message.id),
      eventType: message.role === 'assistant' ? 'conversation.assistant_message.completed' : 'conversation.user_message.created',
      sourceType: 'chat',
      sourceId: sessionId,
      sessionId,
      sourceRevision: String(message.sourceRevision ?? message.source_revision ?? '1'),
      isFinal: true,
      contentType: 'plain_text',
      content: String(message.content).slice(0, 12_000),
      correlationId: message.role === 'assistant' ? (message.regeneratedFrom || message.id) : message.id,
      producer: message.role === 'assistant' ? 'chat-finalizer' : 'chat-adapter',
      channel: String(message.channel || '默认').slice(0, 60),
      allowInternal: message.role === 'assistant'
    }));
}

function actualKey(event) {
  return `${event.eventId}:${event.sourceRevision || '1'}`;
}

export function reconcileChat({ messages = [], sessionId, rawEvents = [] } = {}) {
  if (!sessionId) throw new TypeError('sessionId is required');
  const expected = expectedEvents(messages, sessionId);
  const actual = latestChatEvents(rawEvents.filter(event => event.metadata?.source_type === 'chat' && event.metadata?.source_id === sessionId || event.eventId?.startsWith(`chat:${sessionId}:`)));
  const actualByKey = new Map(actual.map(event => [actualKey(event), event]));
  const missing = [];
  const conflicts = [];
  let matched = 0;
  for (const item of expected) {
    const stored = actualByKey.get(`${item.eventId}:${item.sourceRevision}`);
    if (!stored) {
      missing.push({ eventId: item.eventId, eventType: item.eventType, role: item.eventType.includes('assistant') ? 'assistant' : 'user' });
      continue;
    }
    if (stored.content !== item.content || stored.eventRole !== (item.eventType.includes('assistant') ? 'agent' : 'user') || stored.isStreamFinal === false) {
      conflicts.push({ eventId: item.eventId, eventType: item.eventType, storedContentLength: String(stored.content || '').length, expectedContentLength: item.content.length });
      continue;
    }
    matched += 1;
  }
  const expectedKeys = new Set(expected.map(item => `${item.eventId}:${item.sourceRevision}`));
  const extra = actual.filter(event => !expectedKeys.has(actualKey(event))).map(event => ({ eventId: event.eventId, sourceRevision: event.sourceRevision || '1' }));
  return { sessionId, expectedCount: expected.length, actualCount: actual.length, matched, missing, conflicts, extra, repairable: missing.length > 0 && conflicts.length === 0 && extra.length === 0 };
}

export async function repairChat({ messages = [], sessionId, rawEvents = [], collectEvent } = {}) {
  if (typeof collectEvent !== 'function') throw new TypeError('collectEvent is required');
  const report = reconcileChat({ messages, sessionId, rawEvents });
  if (!report.repairable) return { report, repaired: [], skipped: report.missing };
  const byId = new Map(expectedEvents(messages, sessionId).map(item => [item.eventId, item]));
  const repaired = [];
  for (const missing of report.missing) {
    const expected = byId.get(missing.eventId);
    if (!expected) continue;
    const result = await collectEvent(expected);
    repaired.push({ eventId: expected.eventId, result: result?.result || result?.storage?.result || 'accepted' });
  }
  return { report: reconcileChat({ messages, sessionId, rawEvents: [...rawEvents, ...repaired.map(item => ({ eventId: item.eventId, sourceRevision: byId.get(item.eventId).sourceRevision, eventRole: item.eventId.includes('assistant') ? 'agent' : 'user', content: byId.get(item.eventId).content, isStreamFinal: true, metadata: { source_type: 'chat', source_id: sessionId } }))] }), repaired, skipped: [] };
}

export { eventIdFor };
