import { randomUUID } from 'node:crypto';

export function createGrowthEvidenceService(state, persist = async () => {}) {
  state.evidence ||= [];

  return {
    grow(input = {}) {
      const evidence = {
        id: randomUUID(),
        type: input.type || 'observation',
        claim: String(input.claim || '').slice(0, 300),
        evidence: String(input.evidence || '').slice(0, 500),
        sourceMessageId: input.sourceMessageId || null,
        proposedChange: input.proposedChange || null,
        userConfirmation: null,
        createdAt: new Date().toISOString(),
        status: 'draft'
      };
      state.evidence.unshift(evidence);
      return persist().then(() => evidence);
    },
    trace(id) {
      return state.evidence.find(item => item.id === id) || null;
    },
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
