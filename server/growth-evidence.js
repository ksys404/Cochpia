import { randomUUID } from 'node:crypto';

export function createGrowthEvidenceService(state, persist = async () => {}) {
  state.evidence ||= [];

  const grow = (input = {}) => {
    const evidence = {
      id: randomUUID(),
      type: input.type || 'observation',
      claim: String(input.claim || '').slice(0, 300),
      evidence: String(input.evidence || '').slice(0, 500),
      sourceMessageId: input.sourceMessageId || null,
      sourceEventId: input.sourceEventId || input.source_event_id || null,
      sourceAssertionVersionId: input.sourceAssertionVersionId || input.source_assertion_version_id || null,
      proposedChange: input.proposedChange || null,
      userConfirmation: null,
      createdAt: new Date().toISOString(),
      status: 'draft'
    };
    state.evidence.unshift(evidence);
    return persist().then(() => evidence);
  };

  const growFromSourceEvent = (sourceEventId, input = {}) => {
    const normalizedSourceEventId = String(sourceEventId || '').trim();
    if (!normalizedSourceEventId) throw new Error('sourceEventId is required');
    const type = input.type || 'life_event';
    const existing = state.evidence.find(item => item.sourceEventId === normalizedSourceEventId && item.type === type);
    if (existing) return Promise.resolve({ ...structuredClone(existing), duplicate: true });
    return grow({ ...input, type, sourceEventId: normalizedSourceEventId });
  };

  return {
    grow,
    growFromSourceEvent,
    growFromSourceEvent(sourceEventId, input = {}) {
      const normalizedSourceEventId = String(sourceEventId || '').trim();
      if (!normalizedSourceEventId) throw new Error('sourceEventId is required');
      const existing = state.evidence.find(item => item.sourceEventId === normalizedSourceEventId && item.type === (input.type || 'life_event'));
      if (existing) return Promise.resolve({ ...structuredClone(existing), duplicate: true });
      return this.grow({ ...input, type: input.type || 'life_event', sourceEventId: normalizedSourceEventId });
    },
    trace(id) {
      return state.evidence.find(item => item.id === id) || null;
    },
    updateEvidence(id, status, { persist: shouldPersist = true } = {}) {
      const evidence = state.evidence.find(item => item.id === id);
      if (!evidence) return null;
      const normalizedStatus = status === 'approved' ? 'confirmed' : status;
      if (!['draft', 'confirmed', 'rejected'].includes(normalizedStatus)) throw new Error('Invalid evidence status');
      const previous = structuredClone(evidence);
      evidence.status = normalizedStatus;
      evidence.userConfirmation = normalizedStatus === 'confirmed' ? true : normalizedStatus === 'rejected' ? false : null;
      evidence.reviewedAt = new Date().toISOString();
      evidence.updatedAt = new Date().toISOString();
      if (!shouldPersist) return Promise.resolve(evidence);
      return persist().then(() => evidence).catch(error => {
        Object.assign(evidence, previous);
        throw error;
      });
    }
  };
}
