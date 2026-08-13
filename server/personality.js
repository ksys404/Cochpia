import { randomUUID } from 'node:crypto';

export function applyPersonalityChange(personality, history, { evidenceId, proposedChange, action = 'growth_confirmed', now = new Date().toISOString() } = {}) {
  const traitKey = String(proposedChange?.traitKey || '').trim();
  const delta = Number(proposedChange?.delta);
  if (!traitKey || !Number.isFinite(delta) || delta === 0) return null;
  const trait = personality.traits.find(item => item.key === traitKey);
  if (!trait) return null;
  const previousVersion = personality.version;
  const nextTraits = personality.traits.map(item => item.key === traitKey
    ? { ...item, value: Math.max(0, Math.min(1, item.value + delta)) }
    : item);
  const nextPersonality = { ...personality, version: previousVersion + 1, traits: nextTraits, updatedAt: now };
  const nextHistory = [{
    version: nextPersonality.version,
    traits: structuredClone(nextTraits),
    summary: nextPersonality.summary,
    updatedAt: now,
    action,
    sourceEvidenceId: evidenceId || null,
    previousVersion
  }, ...history];
  return { personality: nextPersonality, history: nextHistory };
}

export function createPersonalityRollbackAudit({ fromVersion, toVersion, source = 'user', now = new Date().toISOString() }) {
  return { id: randomUUID(), action: 'rollback', fromVersion, toVersion, source, createdAt: now };
}
