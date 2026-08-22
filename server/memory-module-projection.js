import { randomUUID } from 'node:crypto';

function visibleScope(assertion, scopeType, relationshipAgentId) {
  if (assertion.scopeType !== scopeType) return false;
  return scopeType !== 'relationship' || assertion.relationshipAgentId === relationshipAgentId;
}

export function projectStableProfile({ state, tenantId, userId, scopeType = 'user', relationshipAgentId = null, policyVersion = state?.policyVersion || 'memory-policy-v1' } = {}) {
  if (!state || !tenantId || !userId) throw new TypeError('state, tenantId, and userId are required');
  state.profileProjections ||= [];
  state.profileProjectionItems ||= [];
  state.profileProjectionSources ||= [];
  for (const projection of state.profileProjections.filter(item => item.tenantId === tenantId && item.userId === userId && item.scopeType === scopeType && item.relationshipAgentId === relationshipAgentId && item.status === 'active')) {
    projection.status = 'superseded';
    projection.updatedAt = new Date().toISOString();
  }
  const projection = { id: randomUUID(), tenantId, userId, scopeType, relationshipAgentId, projectionType: scopeType === 'relationship' ? 'relationship_profile' : 'user_profile', sourceCommitSeq: Number(state.sequence || 0), promotionPolicyVersion: policyVersion, modelVersion: 'deterministic-profile-v1', status: 'active', createdAt: new Date().toISOString(), activatedAt: new Date().toISOString(), resourceRevision: 1 };
  state.profileProjections.push(projection);
  const assertions = (state.assertions || []).filter(assertion => assertion.tenantId === tenantId
    && assertion.userId === userId
    && assertion.status === 'active'
    && assertion.sensitivity === 'S0'
    && visibleScope(assertion, scopeType, relationshipAgentId));
  for (const assertion of assertions) {
    const version = state.assertionVersions.find(item => item.id === assertion.currentVersionId);
    if (!version) continue;
    const sources = state.assertionVersionSources.filter(item => item.versionId === version.id).map(item => item.sourceId);
    if (!sources.length) continue;
    const createdAt = new Date().toISOString();
    state.profileProjectionItems.push({ projectionId: projection.id, tenantId, userId, assertionId: assertion.id, versionId: version.id, displayText: version.content, structuredData: version.structuredData || {}, sourceRefs: sources, createdAt });
    for (const sourceId of sources) state.profileProjectionSources.push({ tenantId, projectionId: projection.id, userId, assertionId: assertion.id, versionId: version.id, sourceId, createdAt });
  }
  return structuredClone({ projection, items: state.profileProjectionItems.filter(item => item.projectionId === projection.id) });
}
