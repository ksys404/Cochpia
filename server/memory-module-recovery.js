import { removeAccountDataForSubject } from './memory-module.js';

export function replayRedactionLedger(state) {
  state.tombstones ||= [];
  state.rawEvents ||= [];
  state.sessions ||= [];
  state.profileSnapshots ||= [];
  state.assertions ||= [];
  state.assertionVersions ||= [];
  state.assertionVersionSources ||= [];
  state.profileSnapshotItems ||= [];
  state.profileProjections ||= [];
  state.profileProjectionItems ||= [];
  state.profileProjectionSources ||= [];
  state.indexDocuments ||= [];
  state.episodes ||= [];
  state.episodeMembers ||= [];
  state.currentStates ||= [];
  state.currentStateSources ||= [];
  state.confirmations ||= [];
  state.accessConfirmations ||= [];
  state.pins ||= [];
  state.outboxEvents ||= [];
  let applied = 0;
  const cleanReferences = ({ rawEventIds = [], assertionIds = [], versionIds = [], preserveRedactedOutbox = false } = {}) => {
    const rawIds = new Set(rawEventIds);
    const memoryIds = new Set(assertionIds);
    const versionIdSet = new Set(versionIds);
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    const affectedProjectionIds = new Set(state.profileProjectionItems.filter(item => memoryIds.has(item.assertionId) || versionIdSet.has(item.versionId)).map(item => item.projectionId));
    state.profileProjectionItems = state.profileProjectionItems.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjectionSources = state.profileProjectionSources.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjections = state.profileProjections.map(item => affectedProjectionIds.has(item.id) ? { ...item, status: 'invalidated' } : item);
    state.indexDocuments = state.indexDocuments.filter(item => !memoryIds.has(item.sourceId) && !versionIdSet.has(item.sourceVersion));
    state.pins = state.pins.filter(item => !memoryIds.has(item.assertionId));
    state.confirmations = state.confirmations.filter(item => !memoryIds.has(item.candidateAssertionId) && !versionIdSet.has(item.candidateVersionId));
    state.accessConfirmations = state.accessConfirmations.filter(item => !item.memoryIds?.some(memoryId => memoryIds.has(memoryId)));
    const affectedEpisodes = new Set(state.episodeMembers.filter(item => rawIds.has(item.rawEventId) || versionIdSet.has(item.assertionVersionId)).map(item => item.episodeId));
    state.episodeMembers = state.episodeMembers.filter(item => !rawIds.has(item.rawEventId) && !versionIdSet.has(item.assertionVersionId));
    const episodesWithMembers = new Set(state.episodeMembers.map(item => item.episodeId));
    state.episodes = state.episodes.filter(item => episodesWithMembers.has(item.id) || !affectedEpisodes.has(item.id)).map(item => affectedEpisodes.has(item.id) ? { ...item, status: 'invalidated' } : item);
    state.outboxEvents = preserveRedactedOutbox
      ? state.outboxEvents.map(item => rawIds.has(item.aggregateId) || memoryIds.has(item.aggregateId) ? { ...item, status: 'completed', result: 'redacted_during_recovery', leaseOwner: null, leaseUntil: null } : item)
      : state.outboxEvents.filter(item => !rawIds.has(item.aggregateId) && !memoryIds.has(item.aggregateId));
    state.currentStateSources = state.currentStateSources.filter(item => !rawIds.has(item.rawEventId));
  };
  const removeAssertions = assertionIds => {
    const memoryIds = new Set(assertionIds);
    const versionIds = new Set(state.assertionVersions.filter(item => memoryIds.has(item.assertionId)).map(item => item.id));
    state.assertions = state.assertions.filter(item => !memoryIds.has(item.id));
    state.assertionVersions = state.assertionVersions.filter(item => !versionIds.has(item.id));
    state.assertionVersionSources = state.assertionVersionSources.filter(item => !versionIds.has(item.versionId));
    cleanReferences({ assertionIds: [...memoryIds], versionIds: [...versionIds] });
  };
  const removeSourceEvents = rawEventIds => {
    const rawIds = new Set(rawEventIds);
    const sourceRows = state.assertionVersionSources.filter(item => item.sourceType === 'raw_event' && rawIds.has(item.sourceId));
    const affectedVersionIds = new Set(sourceRows.map(item => item.versionId));
    const affectedAssertionIds = new Set(state.assertionVersions.filter(item => affectedVersionIds.has(item.id)).map(item => item.assertionId));
    state.assertionVersionSources = state.assertionVersionSources.filter(item => !(item.sourceType === 'raw_event' && rawIds.has(item.sourceId)));
    const orphanVersionIds = new Set(state.assertionVersions.filter(item => affectedVersionIds.has(item.id) && !state.assertionVersionSources.some(source => source.versionId === item.id)).map(item => item.id));
    const orphanAssertionIds = new Set(state.assertionVersions.filter(item => orphanVersionIds.has(item.id)).map(item => item.assertionId));
    state.assertionVersions = state.assertionVersions.filter(item => !orphanVersionIds.has(item.id));
    state.assertionVersionSources = state.assertionVersionSources.filter(item => !orphanVersionIds.has(item.versionId));
    state.assertions = state.assertions.filter(item => !orphanAssertionIds.has(item.id));
    state.rawEvents = state.rawEvents.filter(item => !rawIds.has(item.id));
    cleanReferences({ rawEventIds: [...rawIds], assertionIds: [...affectedAssertionIds], versionIds: [...orphanVersionIds] });
  };
  const replayPhysicalDelete = tombstone => {
    if (tombstone.targetType === 'memory') removeAssertions([tombstone.targetId]);
    if (tombstone.targetType === 'source_event') removeSourceEvents([tombstone.targetId]);
    if (tombstone.targetType === 'session') {
      const rawIds = state.rawEvents.filter(item => item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id);
      removeSourceEvents(rawIds);
      removeAssertions(state.assertions.filter(item => item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id));
      state.currentStates = state.currentStates.filter(item => !(item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId));
      const sessions = state.sessions.filter(item => item.id === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId);
      const snapshotIds = sessions.map(item => item.profileSnapshotId);
      state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !snapshotIds.includes(item.snapshotId));
      state.profileSnapshots = state.profileSnapshots.filter(item => !snapshotIds.includes(item.id));
      const episodeIds = state.episodes.filter(item => item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id);
      state.episodeMembers = state.episodeMembers.filter(item => !episodeIds.includes(item.episodeId));
      state.sessions = state.sessions.filter(item => !(item.id === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId));
      state.episodes = state.episodes.filter(item => !episodeIds.includes(item.id));
    }
    if (tombstone.targetType === 'relationship') {
      const assertionIds = state.assertions.filter(item => item.scopeType === 'relationship' && item.relationshipAgentId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id);
      removeAssertions(assertionIds);
      const projectionIds = state.profileProjections.filter(item => item.scopeType === 'relationship' && item.relationshipAgentId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id);
      state.profileProjectionItems = state.profileProjectionItems.filter(item => !projectionIds.includes(item.projectionId));
      state.profileProjectionSources = state.profileProjectionSources.filter(item => !projectionIds.includes(item.projectionId));
      state.profileProjections = state.profileProjections.filter(item => !projectionIds.includes(item.id));
    }
    if (tombstone.targetType === 'account') {
      removeAccountDataForSubject(state, { tenantId: tombstone.tenantId, userId: tombstone.userId }, { preserveDeletionLedger: true });
    }
  };
  for (const tombstone of state.tombstones) {
    if (tombstone.action === 'delete') {
      replayPhysicalDelete(tombstone);
      if (tombstone.tenantId && tombstone.userId) {
        const key = `${tombstone.tenantId}:${tombstone.userId}`;
        state.redactionEpochs[key] = Math.max(Number(state.redactionEpochs[key] || 0), Number(tombstone.redactionEpoch || 0));
      }
      continue;
    }
    if (tombstone.targetType === 'memory') {
      const assertion = state.assertions.find(item => item.id === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId);
      if (assertion && assertion.status !== 'forgotten' && assertion.status !== 'revoked') {
        assertion.status = ['forget', 'delete'].includes(tombstone.action) ? 'forgotten' : 'revoked';
        assertion.updatedAt = new Date().toISOString();
        assertion.resourceRevision = Number(assertion.resourceRevision || 1) + 1;
        applied += 1;
      }
      const versionIds = state.assertionVersions.filter(item => item.assertionId === tombstone.targetId).map(item => item.id);
      cleanReferences({ assertionIds: [tombstone.targetId], versionIds, preserveRedactedOutbox: true });
    }
    if (tombstone.targetType === 'source_event') {
      const sourceVersionIds = state.assertionVersionSources.filter(source => source.sourceType === 'raw_event' && source.sourceId === tombstone.targetId).map(source => source.versionId);
      const assertionIds = state.assertionVersions.filter(version => sourceVersionIds.includes(version.id)).map(version => version.assertionId);
      for (const assertion of state.assertions.filter(item => assertionIds.includes(item.id))) {
        assertion.status = 'forgotten';
        assertion.updatedAt = new Date().toISOString();
        assertion.resourceRevision = Number(assertion.resourceRevision || 1) + 1;
        applied += 1;
      }
      cleanReferences({ rawEventIds: [tombstone.targetId], assertionIds, versionIds: sourceVersionIds, preserveRedactedOutbox: true });
    }
    if (tombstone.targetType === 'session') {
      const rawIds = state.rawEvents.filter(item => item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id);
      const sessionAssertions = state.assertions.filter(item => item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId);
      for (const assertion of sessionAssertions) { assertion.status = 'forgotten'; assertion.updatedAt = new Date().toISOString(); assertion.resourceRevision = Number(assertion.resourceRevision || 1) + 1; applied += 1; }
      state.sessions = state.sessions.map(item => item.id === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId
        ? { ...item, status: 'closed', closedAt: new Date().toISOString(), resourceRevision: Number(item.resourceRevision || 1) + 1 }
        : item);
      state.currentStates = state.currentStates.map(item => item.sessionId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId
        ? { ...item, status: 'forgotten', resourceRevision: Number(item.resourceRevision || 1) + 1 }
        : item);
      const assertionIds = sessionAssertions.map(item => item.id);
      const versionIds = state.assertionVersions.filter(item => assertionIds.includes(item.assertionId)).map(item => item.id);
      cleanReferences({ rawEventIds: rawIds, assertionIds, versionIds, preserveRedactedOutbox: true });
    }
    if (tombstone.targetType === 'relationship') {
      const relationshipAssertions = state.assertions.filter(item => item.scopeType === 'relationship' && item.relationshipAgentId === tombstone.targetId && item.tenantId === tombstone.tenantId && item.userId === tombstone.userId);
      for (const assertion of relationshipAssertions) { assertion.status = 'forgotten'; assertion.updatedAt = new Date().toISOString(); assertion.resourceRevision = Number(assertion.resourceRevision || 1) + 1; applied += 1; }
      const assertionIds = relationshipAssertions.map(item => item.id);
      const versionIds = state.assertionVersions.filter(item => assertionIds.includes(item.assertionId)).map(item => item.id);
      cleanReferences({ assertionIds, versionIds, preserveRedactedOutbox: true });
    }
    if (tombstone.targetType === 'account') {
      const rawIds = state.rawEvents.filter(item => item.tenantId === tombstone.tenantId && item.userId === tombstone.userId).map(item => item.id);
      const accountAssertions = state.assertions.filter(item => item.tenantId === tombstone.tenantId && item.userId === tombstone.userId);
      for (const assertion of accountAssertions) { assertion.status = 'forgotten'; assertion.updatedAt = new Date().toISOString(); assertion.resourceRevision = Number(assertion.resourceRevision || 1) + 1; applied += 1; }
      state.sessions = state.sessions.map(item => item.tenantId === tombstone.tenantId && item.userId === tombstone.userId
        ? { ...item, status: 'closed', closedAt: new Date().toISOString(), resourceRevision: Number(item.resourceRevision || 1) + 1 }
        : item);
      state.currentStates = state.currentStates.map(item => item.tenantId === tombstone.tenantId && item.userId === tombstone.userId
        ? { ...item, status: 'forgotten', resourceRevision: Number(item.resourceRevision || 1) + 1 }
        : item);
      const assertionIds = accountAssertions.map(item => item.id);
      const versionIds = state.assertionVersions.filter(item => assertionIds.includes(item.assertionId)).map(item => item.id);
      cleanReferences({ rawEventIds: rawIds, assertionIds, versionIds, preserveRedactedOutbox: true });
    }
    if (tombstone.tenantId && tombstone.userId) {
      const key = `${tombstone.tenantId}:${tombstone.userId}`;
      state.redactionEpochs[key] = Math.max(Number(state.redactionEpochs[key] || 0), Number(tombstone.redactionEpoch || 0));
    }
  }
  return { applied, redactionEpochs: structuredClone(state.redactionEpochs) };
}
