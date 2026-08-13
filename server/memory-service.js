import { randomUUID } from 'node:crypto';

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

// 情感记忆的自然衰减:强度随时间和重要性衰减。
// 重要性越高,衰减越慢。半衰期约为:重要性 1.0 → 约 35 天,0.0 → 约 7 天。
export function decayedStrength(memory, now = new Date()) {
  const base = clamp(Number(memory?.strength ?? 0.5), 0, 1);
  const importance = clamp(Number(memory?.importance ?? 0.5), 0, 1);
  const updatedAt = memory?.updatedAt ? new Date(memory.updatedAt).getTime() : now.getTime();
  const days = Math.max(0, (now.getTime() - updatedAt) / 86400000);
  const lambda = 0.02 + 0.08 * (1 - importance);
  return base * Math.exp(-lambda * days);
}

export function createMemoryService(state, persist) {
  const tools = ['breath', 'hold', 'dream', 'grow', 'trace'];

  const find = id => state.memories.find(item => item.id === id);

  return {
    listTools() { return tools; },
    breath(query, limit = 5) {
      const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const safeLimit = clamp(Number(limit) || 5, 1, 50);
      const now = new Date();
      return state.memories
        .filter(memory => !memory.revokedAt)
        .map(memory => {
          const relevance = terms.length
            ? terms.filter(term => String(memory.summary).toLowerCase().includes(term)).length / terms.length
            : 0;
          const strength = decayedStrength(memory, now);
          const score = terms.length ? 0.7 * relevance + 0.3 * strength : strength;
          return { ...memory, score, relevance, decayedStrength: strength };
        })
        .sort((a, b) => b.score - a.score || b.decayedStrength - a.decayedStrength)
        .slice(0, safeLimit);
    },
    hold(input) {
      const memory = {
        id: randomUUID(),
        type: input.type || 'event',
        category: input.category || input.type || 'episodic',
        summary: String(input.summary || '').slice(0, 500),
        confidence: clamp(Number(input.confidence ?? 0.7), 0, 1),
        source: input.source || 'chat',
        sourceEvent: input.sourceEvent || null,
        visibility: input.visibility || 'shared',
        strength: clamp(Number(input.strength ?? 0.72), 0, 1),
        valence: clamp(Number(input.valence ?? 0), -1, 1),
        arousal: clamp(Number(input.arousal ?? 0.5), 0, 1),
        importance: clamp(Number(input.importance ?? 0.5), 0, 1),
        metadata: input.metadata || {},
        updatedAt: new Date().toISOString()
      };
      if (!memory.summary) throw new Error('Memory summary is required');
      state.memories.unshift(memory);
      return persist().then(() => memory);
    },
    list(options = {}) {
      const limit = clamp(Number(options.limit) || 20, 1, 100);
      return state.memories
        .filter(item => options.includeRevoked === 'true' || !item.revokedAt)
        .filter(item => !options.type || item.type === options.type)
        .filter(item => !options.source || item.source === options.source)
        .slice(0, limit);
    },
    get(id) { return find(id) || null; },
    update(id, input) {
      const memory = find(id);
      if (!memory) return null;
      if (input.type !== undefined) memory.type = String(input.type).slice(0, 60);
      if (input.category !== undefined) memory.category = String(input.category).slice(0, 60);
      if (input.summary !== undefined) {
        const summary = String(input.summary).trim().slice(0, 500);
        if (!summary) throw new Error('Memory summary is required');
        memory.summary = summary;
      }
      if (input.confidence !== undefined) memory.confidence = clamp(Number(input.confidence), 0, 1);
      if (input.strength !== undefined) memory.strength = clamp(Number(input.strength), 0, 1);
      if (input.valence !== undefined) memory.valence = clamp(Number(input.valence), -1, 1);
      if (input.arousal !== undefined) memory.arousal = clamp(Number(input.arousal), 0, 1);
      if (input.importance !== undefined) memory.importance = clamp(Number(input.importance), 0, 1);
      if (input.visibility !== undefined) memory.visibility = String(input.visibility).slice(0, 40);
      if (input.sourceEvent !== undefined) memory.sourceEvent = input.sourceEvent || null;
      if (input.metadata !== undefined && input.metadata && typeof input.metadata === 'object') memory.metadata = input.metadata;
      memory.updatedAt = new Date().toISOString();
      return persist().then(() => memory);
    },
    remove(id) {
      const index = state.memories.findIndex(item => item.id === id);
      if (index === -1) return false;
      state.memories.splice(index, 1);
      return persist().then(() => true);
    },
    revoke(id) {
      const memory = find(id);
      if (!memory) return null;
      memory.revokedAt = new Date().toISOString();
      memory.visibility = 'revoked';
      return persist().then(() => memory);
    },
    exportMemories() {
      return structuredClone(state.memories);
    },
    dream(limit = 5) {
      const now = new Date();
      return this.list({ limit })
        .map(memory => ({ ...memory, decayedStrength: decayedStrength(memory, now) }))
        .sort((a, b) => b.decayedStrength - a.decayedStrength || new Date(b.updatedAt) - new Date(a.updatedAt));
    },
    grow(input) {
      const evidence = { id: randomUUID(), type: input.type || 'observation', claim: String(input.claim || '').slice(0, 300), evidence: String(input.evidence || '').slice(0, 500), sourceMessageId: input.sourceMessageId || null, proposedChange: input.proposedChange || null, userConfirmation: null, createdAt: new Date().toISOString(), status: 'draft' };
      state.evidence.unshift(evidence);
      return persist().then(() => evidence);
    },
    trace(id) { return state.evidence.find(item => item.id === id) || null; },
    updateEvidence(id, status) {
      const evidence = state.evidence.find(item => item.id === id);
      if (!evidence) return null;
      const normalizedStatus = status === 'approved' ? 'confirmed' : status;
      if (!['draft', 'confirmed', 'rejected'].includes(normalizedStatus)) throw new Error('Invalid evidence status');
      evidence.status = normalizedStatus;
      evidence.userConfirmation = normalizedStatus === 'confirmed' ? true : normalizedStatus === 'rejected' ? false : null;
      evidence.reviewedAt = new Date().toISOString();
      evidence.updatedAt = new Date().toISOString();
      return persist().then(() => evidence);
    }
  };
}
