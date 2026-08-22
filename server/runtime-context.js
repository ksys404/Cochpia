const MAX_CONTEXT_MESSAGES = 20;

export function buildRuntimeContext({ messages = [], personality = null, recalled = [], memoryBundle = null, summary = '', persona = '', upcomingEvents = [], atmosphere = '', profile = null, mode = 'companion' } = {}) {
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
    memoryBundle: memoryBundle || null,
    summary: String(summary || ''),
    persona: String(persona || ''),
    atmosphere: String(atmosphere || ''),
    upcomingEvents: (upcomingEvents || []).map(event => ({
      type: event.type,
      title: event.title,
      date: event.date,
      note: event.note
    })),
    profile: profile ? { name: profile.name, gender: profile.gender, age: profile.age } : null,
    mode: String(mode || 'companion')
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
