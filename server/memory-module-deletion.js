import { randomUUID } from 'node:crypto';

const defaultNowIso = () => new Date().toISOString();

export function removeAccountDataForSubject(state, { tenantId, userId }, { preserveDeletionLedger = false } = {}) {
  if (!state || !tenantId || !userId) throw new TypeError('state, tenantId, and userId are required');
  const belongs = item => item?.tenantId === tenantId && (item.userId === userId || item.subjectUserId === userId);
  const rawEventIds = new Set((state.rawEvents || []).filter(belongs).map(item => item.id));
  const sessionIds = new Set((state.sessions || []).filter(belongs).map(item => item.id));
  const assertionIds = new Set((state.assertions || []).filter(belongs).map(item => item.id));
  const versionIds = new Set((state.assertionVersions || []).filter(item => assertionIds.has(item.assertionId)).map(item => item.id));
  const snapshotIds = new Set((state.profileSnapshots || []).filter(belongs).map(item => item.id));
  const projectionIds = new Set((state.profileProjections || []).filter(belongs).map(item => item.id));
  const currentStateIds = new Set((state.currentStates || []).filter(belongs).map(item => item.id));
  const episodeIds = new Set((state.episodes || []).filter(belongs).map(item => item.id));
  const memoryIds = assertionIds;

  state.rawEvents = (state.rawEvents || []).filter(item => !rawEventIds.has(item.id) && !belongs(item));
  state.sessions = (state.sessions || []).filter(item => !sessionIds.has(item.id) && !belongs(item));
  state.profileSnapshots = (state.profileSnapshots || []).filter(item => !snapshotIds.has(item.id) && !belongs(item));
  state.profileSnapshotItems = (state.profileSnapshotItems || []).filter(item => !belongs(item) && !snapshotIds.has(item.snapshotId) && !memoryIds.has(item.assertionId) && !versionIds.has(item.versionId));
  state.profileProjections = (state.profileProjections || []).filter(item => !projectionIds.has(item.id) && !belongs(item));
  state.profileProjectionItems = (state.profileProjectionItems || []).filter(item => !belongs(item) && !projectionIds.has(item.projectionId) && !memoryIds.has(item.assertionId) && !versionIds.has(item.versionId));
  state.profileProjectionSources = (state.profileProjectionSources || []).filter(item => !belongs(item) && !projectionIds.has(item.projectionId) && !memoryIds.has(item.assertionId) && !versionIds.has(item.versionId));
  state.assertions = (state.assertions || []).filter(item => !assertionIds.has(item.id) && !belongs(item));
  state.assertionVersions = (state.assertionVersions || []).filter(item => !versionIds.has(item.id));
  state.assertionVersionSources = (state.assertionVersionSources || []).filter(item => !versionIds.has(item.versionId) && !(item.sourceType === 'raw_event' && rawEventIds.has(item.sourceId)));
  state.currentStates = (state.currentStates || []).filter(item => !currentStateIds.has(item.id) && !belongs(item));
  state.currentStateSources = (state.currentStateSources || []).filter(item => !belongs(item) && !currentStateIds.has(item.currentStateId) && !rawEventIds.has(item.rawEventId));
  state.confirmations = (state.confirmations || []).filter(item => !belongs(item) && !memoryIds.has(item.candidateAssertionId) && !versionIds.has(item.candidateVersionId));
  state.accessConfirmations = (state.accessConfirmations || []).filter(item => !belongs(item) && !item.memoryIds?.some(id => memoryIds.has(id)));
  state.mentionCooldowns = (state.mentionCooldowns || []).filter(item => !belongs(item) && !memoryIds.has(item.memoryId));
  state.pins = (state.pins || []).filter(item => !belongs(item) && !memoryIds.has(item.assertionId) && !versionIds.has(item.pinnedVersionId));
  state.indexDocuments = (state.indexDocuments || []).filter(item => !belongs(item) && !memoryIds.has(item.sourceId) && !versionIds.has(item.sourceVersion));
  state.episodes = (state.episodes || []).filter(item => !episodeIds.has(item.id) && !belongs(item));
  state.episodeMembers = (state.episodeMembers || []).filter(item => !belongs(item) && !episodeIds.has(item.episodeId) && !rawEventIds.has(item.rawEventId) && !versionIds.has(item.assertionVersionId));
  state.scopeGrants = (state.scopeGrants || []).filter(item => !belongs(item));
  state.outboxEvents = (state.outboxEvents || []).filter(item => !belongs(item) && !rawEventIds.has(item.aggregateId) && !memoryIds.has(item.aggregateId) && !versionIds.has(item.aggregateId) && !currentStateIds.has(item.aggregateId) && !sessionIds.has(item.aggregateId));
  state.exportOperations = (state.exportOperations || []).filter(item => !belongs(item));
  state.idempotencyRecords = (state.idempotencyRecords || []).filter(item => !belongs(item));
  state.auditEvents = (state.auditEvents || []).filter(item => !belongs(item));
  if (!preserveDeletionLedger) {
    state.deletionOperations = (state.deletionOperations || []).filter(item => !belongs(item));
    state.tombstones = (state.tombstones || []).filter(item => !belongs(item));
  }
}

export function createMemoryDeletionCoordinator({
  state,
  nowIso = defaultNowIso,
  bumpEpoch,
  audit,
  invalidateMutationRecords,
  mutationNamespaceOf
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Memory deletion state is required');
  if (typeof bumpEpoch !== 'function') throw new TypeError('Memory deletion epoch hook is required');
  if (typeof audit !== 'function') throw new TypeError('Memory deletion audit hook is required');
  if (typeof invalidateMutationRecords !== 'function') throw new TypeError('Memory deletion mutation invalidation hook is required');
  if (typeof mutationNamespaceOf !== 'function') throw new TypeError('Memory deletion namespace hook is required');

  const cleanDerivedForDeletion = ({ rawEventIds = [], assertionIds = [], versionIds = [], preserveRedactedOutbox = false } = {}) => {
    state.profileSnapshots ||= [];
    state.profileSnapshotItems ||= [];
    state.profileProjections ||= [];
    state.profileProjectionItems ||= [];
    state.profileProjectionSources ||= [];
    state.currentStateSources ||= [];
    state.indexDocuments ||= [];
    state.mentionCooldowns ||= [];
    state.episodes ||= [];
    state.episodeMembers ||= [];
    const rawIds = new Set(rawEventIds);
    const memoryIds = new Set(assertionIds);
    const versionIdSet = new Set(versionIds);
    const affectedProjectionIds = new Set(state.profileProjectionItems
      .filter(item => memoryIds.has(item.assertionId) || versionIdSet.has(item.versionId))
      .map(item => item.projectionId));
    state.profileSnapshotItems = state.profileSnapshotItems.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjectionItems = state.profileProjectionItems.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjectionSources = state.profileProjectionSources.filter(item => !memoryIds.has(item.assertionId) && !versionIdSet.has(item.versionId));
    state.profileProjections = state.profileProjections.map(projection => affectedProjectionIds.has(projection.id) ? { ...projection, status: 'invalidated', updatedAt: nowIso() } : projection);
    state.indexDocuments = state.indexDocuments.filter(document => !memoryIds.has(document.sourceId) && !versionIdSet.has(document.sourceVersion));
    state.pins = state.pins.filter(pinRecord => !memoryIds.has(pinRecord.assertionId));
    state.confirmations = state.confirmations.filter(confirmation => !memoryIds.has(confirmation.candidateAssertionId) && !versionIdSet.has(confirmation.candidateVersionId));
    state.accessConfirmations = state.accessConfirmations.filter(access => !access.memoryIds?.some(memoryId => memoryIds.has(memoryId)));
    state.mentionCooldowns = state.mentionCooldowns.filter(record => !memoryIds.has(record.memoryId));
    const affectedEpisodeIds = new Set(state.episodeMembers
      .filter(member => rawIds.has(member.rawEventId) || versionIdSet.has(member.assertionVersionId))
      .map(member => member.episodeId));
    state.episodeMembers = state.episodeMembers.filter(member => !rawIds.has(member.rawEventId) && !versionIdSet.has(member.assertionVersionId));
    const episodeIdsWithMembers = new Set(state.episodeMembers.map(member => member.episodeId));
    state.episodes = state.episodes
      .filter(episode => episodeIdsWithMembers.has(episode.id) || !affectedEpisodeIds.has(episode.id))
      .map(episode => affectedEpisodeIds.has(episode.id) ? { ...episode, status: 'invalidated', updatedAt: nowIso() } : episode);
    state.outboxEvents = preserveRedactedOutbox
      ? state.outboxEvents.map(event => rawIds.has(event.aggregateId) || memoryIds.has(event.aggregateId) ? { ...event, status: 'completed', result: 'redacted', leaseOwner: null, leaseUntil: null } : event)
      : state.outboxEvents.filter(event => !rawIds.has(event.aggregateId) && !memoryIds.has(event.aggregateId));
    state.currentStateSources = state.currentStateSources.filter(item => !rawIds.has(item.rawEventId));
  };

  const physicallyRemoveAssertions = assertionIds => {
    const memoryIds = new Set(assertionIds);
    const versionIds = new Set(state.assertionVersions.filter(version => memoryIds.has(version.assertionId)).map(version => version.id));
    state.assertions = state.assertions.filter(assertion => !memoryIds.has(assertion.id));
    state.assertionVersions = state.assertionVersions.filter(version => !versionIds.has(version.id));
    state.assertionVersionSources = state.assertionVersionSources.filter(source => !versionIds.has(source.versionId));
    state.mentionCooldowns = (state.mentionCooldowns || []).filter(record => !memoryIds.has(record.memoryId));
    cleanDerivedForDeletion({ assertionIds: [...memoryIds], versionIds: [...versionIds] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: [...memoryIds] });
    return { assertionIds: [...memoryIds], versionIds: [...versionIds] };
  };

  const physicallyRemoveSourceEvents = sourceEventIds => {
    const rawIds = new Set(sourceEventIds);
    const removedEventKeys = new Set(state.rawEvents
      .filter(event => rawIds.has(event.id))
      .map(event => `${event.eventId}:${event.sourceRevision}`));
    const sourceRows = state.assertionVersionSources.filter(source => source.sourceType === 'raw_event' && rawIds.has(source.sourceId));
    const affectedVersionIds = new Set(sourceRows.map(source => source.versionId));
    const affectedAssertionIds = new Set(state.assertionVersions.filter(version => affectedVersionIds.has(version.id)).map(version => version.assertionId));
    state.assertionVersionSources = state.assertionVersionSources.filter(source => !(source.sourceType === 'raw_event' && rawIds.has(source.sourceId)));
    const orphanVersionIds = new Set(state.assertionVersions
      .filter(version => affectedVersionIds.has(version.id) && !state.assertionVersionSources.some(source => source.versionId === version.id))
      .map(version => version.id));
    const orphanAssertionIds = new Set(state.assertionVersions.filter(version => orphanVersionIds.has(version.id)).map(version => version.assertionId));
    state.assertionVersions = state.assertionVersions.filter(version => !orphanVersionIds.has(version.id));
    state.assertionVersionSources = state.assertionVersionSources.filter(source => !orphanVersionIds.has(source.versionId));
    for (const assertion of state.assertions.filter(item => affectedAssertionIds.has(item.id) && !orphanAssertionIds.has(item.id))) {
      const remaining = state.assertionVersions.filter(version => version.assertionId === assertion.id).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
      assertion.currentVersionId = remaining[0]?.id || null;
      if (remaining[0]) remaining[0].versionStatus = 'current';
    }
    state.assertions = state.assertions.filter(assertion => !orphanAssertionIds.has(assertion.id));
    state.rawEvents = state.rawEvents.filter(event => !rawIds.has(event.id));
    cleanDerivedForDeletion({ rawEventIds: [...rawIds], assertionIds: [...affectedAssertionIds], versionIds: [...orphanVersionIds] });
    invalidateMutationRecords({ resourceType: 'source_event', resourceIds: [...rawIds] });
    invalidateMutationRecords({ resourceType: 'memory', resourceIds: [...affectedAssertionIds] });
    state.idempotencyRecords = state.idempotencyRecords.filter(record => mutationNamespaceOf(record) !== 'event' || !removedEventKeys.has(record.key));
    return { rawEventIds: [...rawIds], assertionIds: [...affectedAssertionIds], versionIds: [...orphanVersionIds] };
  };

  const newDeletionOperation = (context, targetType, targetId, requestedScope) => {
    const at = nowIso();
    const operation = {
      id: randomUUID(),
      tenantId: context.tenantId,
      subjectUserId: context.subjectUserId,
      targetType,
      targetId,
      requestedScope,
      action: 'delete',
      status: 'completed',
      requestedBy: context.actorId,
      requestedAt: at,
      canonicalHiddenAt: at,
      completedAt: at,
      redactionEpoch: bumpEpoch(context),
      resourceRevision: 1,
      lastErrorCode: null
    };
    state.deletionOperations.push(operation);
    state.tombstones.push({ id: randomUUID(), tenantId: context.tenantId, userId: context.subjectUserId, targetType, targetId, action: 'delete', redactionEpoch: operation.redactionEpoch, createdAt: at });
    return operation;
  };

  return { cleanDerivedForDeletion, physicallyRemoveAssertions, physicallyRemoveSourceEvents, newDeletionOperation };
}
