import { randomUUID } from 'node:crypto';
import { applyPersonalityChange, createPersonalityRollbackAudit } from './personality.js';

const clone = value => structuredClone(value);

export function createPersonalityProjection(state, persist = async () => {}, { now = () => new Date() } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Personality projection state is required');
  const ensureState = () => {
    state.personality ||= { version: 1, traits: [], summary: '', updatedAt: new Date(now()).toISOString() };
    state.personality.version = Math.max(1, Math.floor(Number(state.personality.version) || 1));
    state.personality.traits = Array.isArray(state.personality.traits) ? state.personality.traits : [];
    state.personality.resourceRevision = Math.max(1, Math.floor(Number(state.personality.resourceRevision) || 1));
    state.personalityHistory ||= [{ version: state.personality.version, traits: clone(state.personality.traits), summary: state.personality.summary || '', updatedAt: state.personality.updatedAt || new Date(now()).toISOString() }];
    state.personalityAudit ||= [];
    state.personalityProjection ||= { appliedEvidenceIds: [], appliedSourceEventIds: [] };
    state.personalityProjection.appliedEvidenceIds = Array.isArray(state.personalityProjection.appliedEvidenceIds) ? state.personalityProjection.appliedEvidenceIds : [];
    state.personalityProjection.appliedSourceEventIds = Array.isArray(state.personalityProjection.appliedSourceEventIds) ? state.personalityProjection.appliedSourceEventIds : [];
  };
  ensureState();

  const get = () => {
    ensureState();
    return { personality: clone(state.personality), history: clone(state.personalityHistory), audit: clone(state.personalityAudit) };
  };

  const applyConfirmedEvidence = async (evidence, { expectedRevision = null } = {}) => {
    ensureState();
    if (!evidence?.id) throw Object.assign(new Error('Evidence is required'), { code: 'PERSONALITY_EVIDENCE_REQUIRED', status: 400 });
    if (state.personalityProjection.appliedEvidenceIds.includes(evidence.id)) return { ...get(), duplicate: true };
    if (expectedRevision != null && Number(expectedRevision) !== Number(state.personality.resourceRevision)) throw Object.assign(new Error('Personality projection revision is stale'), { code: 'PERSONALITY_REVISION_CONFLICT', status: 409, currentResourceRevision: state.personality.resourceRevision });
    const change = applyPersonalityChange(state.personality, state.personalityHistory, {
      evidenceId: evidence.id,
      sourceEventId: evidence.sourceEventId || null,
      sourceAssertionVersionId: evidence.sourceAssertionVersionId || null,
      proposedChange: evidence.proposedChange,
      now: new Date(now()).toISOString()
    });
    if (!change) return { ...get(), duplicate: false, applied: false };
    const previous = { personality: clone(state.personality), history: clone(state.personalityHistory), audit: clone(state.personalityAudit), projection: clone(state.personalityProjection) };
    state.personality = { ...change.personality, resourceRevision: state.personality.resourceRevision + 1 };
    state.personalityHistory = change.history;
    const audit = { id: randomUUID(), action: 'growth_confirmed', evidenceId: evidence.id, sourceEventId: evidence.sourceEventId || null, sourceAssertionVersionId: evidence.sourceAssertionVersionId || null, version: state.personality.version, resourceRevision: state.personality.resourceRevision, createdAt: new Date(now()).toISOString() };
    state.personalityAudit.unshift(audit);
    state.personalityProjection.appliedEvidenceIds = [evidence.id, ...state.personalityProjection.appliedEvidenceIds].slice(0, 500);
    if (evidence.sourceEventId) state.personalityProjection.appliedSourceEventIds = [evidence.sourceEventId, ...state.personalityProjection.appliedSourceEventIds].filter((item, index, all) => all.indexOf(item) === index).slice(0, 500);
    try {
      await persist();
    } catch (error) {
      state.personality = previous.personality;
      state.personalityHistory = previous.history;
      state.personalityAudit = previous.audit;
      state.personalityProjection = previous.projection;
      throw error;
    }
    return { ...get(), audit, duplicate: false, applied: true };
  };

  const rollback = async (version, { expectedRevision = null, source = 'user' } = {}) => {
    ensureState();
    const targetVersion = Number(version);
    const snapshot = state.personalityHistory.find(item => item.version === targetVersion);
    if (!snapshot) throw Object.assign(new Error('Personality version not found'), { code: 'PERSONALITY_VERSION_NOT_FOUND', status: 404 });
    if (expectedRevision != null && Number(expectedRevision) !== Number(state.personality.resourceRevision)) throw Object.assign(new Error('Personality projection revision is stale'), { code: 'PERSONALITY_REVISION_CONFLICT', status: 409, currentResourceRevision: state.personality.resourceRevision });
    const fromVersion = state.personality.version;
    state.personality = { version: snapshot.version, traits: clone(snapshot.traits), summary: snapshot.summary, updatedAt: new Date(now()).toISOString(), resourceRevision: state.personality.resourceRevision + 1 };
    const audit = { ...createPersonalityRollbackAudit({ fromVersion, toVersion: snapshot.version, source, now: new Date(now()).toISOString() }), resourceRevision: state.personality.resourceRevision };
    state.personalityAudit.unshift(audit);
    await persist();
    return { ...get(), audit };
  };

  const rebuildFromConfirmedEvidence = async ({ excludedSourceEventIds = [], source = 'governance' } = {}) => {
    ensureState();
    const excluded = new Set(excludedSourceEventIds.map(String));
    const initial = [...state.personalityHistory].sort((left, right) => Number(left.version) - Number(right.version))[0] || {
      version: 1,
      traits: clone(state.personality.traits),
      summary: state.personality.summary || '',
      updatedAt: new Date(now()).toISOString()
    };
    const previous = { personality: clone(state.personality), history: clone(state.personalityHistory), audit: clone(state.personalityAudit), projection: clone(state.personalityProjection) };
    let rebuiltPersonality = {
      ...clone(state.personality),
      version: Number(initial.version) || 1,
      traits: clone(initial.traits || []),
      summary: initial.summary || '',
      updatedAt: new Date(now()).toISOString()
    };
    let rebuiltHistory = [clone(initial)];
    const appliedEvidenceIds = [];
    const appliedSourceEventIds = [];
    const confirmed = (state.evidence || [])
      .filter(item => item.status === 'confirmed' && (!item.sourceEventId || !excluded.has(String(item.sourceEventId))))
      .sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
    for (const evidence of confirmed) {
      const change = applyPersonalityChange(rebuiltPersonality, rebuiltHistory, {
        evidenceId: evidence.id,
        sourceEventId: evidence.sourceEventId || null,
        sourceAssertionVersionId: evidence.sourceAssertionVersionId || null,
        proposedChange: evidence.proposedChange,
        now: new Date(now()).toISOString()
      });
      if (!change) continue;
      rebuiltPersonality = change.personality;
      rebuiltHistory = change.history;
      appliedEvidenceIds.push(evidence.id);
      if (evidence.sourceEventId) appliedSourceEventIds.push(String(evidence.sourceEventId));
    }
    const timestamp = new Date(now()).toISOString();
    const audit = {
      id: randomUUID(),
      action: 'rebuild_after_redaction',
      source,
      excludedSourceEventIds: [...excluded],
      fromVersion: previous.personality.version,
      toVersion: rebuiltPersonality.version,
      createdAt: timestamp,
      resourceRevision: previous.personality.resourceRevision + 1
    };
    state.personality = { ...rebuiltPersonality, resourceRevision: audit.resourceRevision, updatedAt: timestamp };
    state.personalityHistory = rebuiltHistory;
    state.personalityAudit.unshift(audit);
    state.personalityProjection = {
      ...state.personalityProjection,
      appliedEvidenceIds,
      appliedSourceEventIds: [...new Set(appliedSourceEventIds)],
      lastRebuiltAt: timestamp
    };
    try {
      await persist();
    } catch (error) {
      state.personality = previous.personality;
      state.personalityHistory = previous.history;
      state.personalityAudit = previous.audit;
      state.personalityProjection = previous.projection;
      throw error;
    }
    return { ...get(), audit, rebuilt: true };
  };

  return { get, applyConfirmedEvidence, rollback, rebuildFromConfirmedEvidence };
}
