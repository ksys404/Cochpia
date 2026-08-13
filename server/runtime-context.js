const MAX_CONTEXT_MESSAGES = 20;

export function buildRuntimeContext({ messages = [], personality = null, recalled = [], summary = '', persona = '', upcomingEvents = [], atmosphere = '' } = {}) {
  return {
    messages: messages.filter(message => !message.supersededAt).slice(-MAX_CONTEXT_MESSAGES).map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt
    })),
    personality: personality ? {
      version: personality.version,
      summary: personality.summary,
      traits: (personality.traits || []).map(trait => ({ key: trait.key, label: trait.label, value: trait.value }))
    } : null,
    recalled: recalled.map(memory => ({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      confidence: memory.confidence,
      source: memory.source
    })),
    summary: String(summary || ''),
    persona: String(persona || ''),
    atmosphere: String(atmosphere || ''),
    upcomingEvents: (upcomingEvents || []).map(event => ({
      type: event.type,
      title: event.title,
      date: event.date,
      note: event.note
    }))
  };
}

export function findRegenerationTarget(messages = [], messageId) {
  const index = messages.findIndex(message => message.id === messageId);
  if (index === -1 || messages[index].role !== 'assistant') return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return { assistant: messages[index], user: messages[cursor], index };
  }
  return null;
}
