import { randomUUID } from 'node:crypto';
import { createMemoryModule } from './memory-module.js';
import { createMemoryModuleWorker } from './memory-module-worker.js';
import { processExtractionEvent } from './memory-module-extraction-worker.js';
import { rebuildEpisodes } from './memory-module-episodes.js';
import { resolveMemoryFeatureFlags, featureEnabled } from './memory-module-flags.js';
import { rebuildIndexDocumentsAsync } from './memory-module-index.js';
import { projectStableProfile } from './memory-module-projection.js';
import { isSupersededSourceEvent } from './memory-module-event-order.js';

function derivedEventTypes(featureFlags) {
  const indexEnabled = featureEnabled(featureFlags, 'hybridRetrieval') || featureEnabled(featureFlags, 'vectorRetrieval');
  const types = new Set();
  if (featureEnabled(featureFlags, 'autoExtract') || featureEnabled(featureFlags, 'autoProfileUpdate') || featureEnabled(featureFlags, 'episodeGrouping') || indexEnabled) types.add('raw_event.created');
  if (featureEnabled(featureFlags, 'autoProfileUpdate') || indexEnabled) types.add('assertion.active');
  return [...types];
}

function relationshipAgents(state, tenantId, userId) {
  return [...new Set((state.assertions || [])
    .filter(assertion => assertion.tenantId === tenantId && assertion.userId === userId && assertion.scopeType === 'relationship' && assertion.relationshipAgentId)
    .map(assertion => assertion.relationshipAgentId))];
}

async function rebuildDerivedState(state, { event, featureFlags, embeddingGateway = null }) {
  const tenantId = event.tenantId;
  const userId = event.userId;
  const sourceEvent = event.type === 'raw_event.created'
    ? state.rawEvents?.find(item => item.id === event.aggregateId)
    : null;
  const indexEnabled = featureEnabled(featureFlags, 'hybridRetrieval') || featureEnabled(featureFlags, 'vectorRetrieval');

  if (indexEnabled && (event.type === 'raw_event.created' || event.type === 'assertion.active')) {
    await rebuildIndexDocumentsAsync(state, { tenantId, userId, embeddingGateway });
  }
  if (featureEnabled(featureFlags, 'autoProfileUpdate') && (event.type === 'raw_event.created' || event.type === 'assertion.active')) {
    projectStableProfile({ state, tenantId, userId, scopeType: 'user' });
    for (const relationshipAgentId of relationshipAgents(state, tenantId, userId)) {
      projectStableProfile({ state, tenantId, userId, scopeType: 'relationship', relationshipAgentId });
    }
  }
  if (featureEnabled(featureFlags, 'episodeGrouping') && event.type === 'raw_event.created') {
    rebuildEpisodes(state, { tenantId, userId, sessionId: sourceEvent?.sessionId || null });
  }
  return { sourceEventId: sourceEvent?.id || null, indexEnabled };
}

export function createMemoryModuleServiceWorker({
  repository,
  featureFlags = resolveMemoryFeatureFlags(),
  modelGateway = null,
  embeddingGateway = null,
  allowSensitiveModelInput = false,
  workerId = randomUUID(),
  leaseMs = 30_000,
  maxAttempts = 5,
  pollIntervalMs = 1_000,
  batchSize = 10,
  supportedSchemaVersions = [1],
  retentionSweepIntervalMs = 60_000,
  retentionSweepBatchSize = 10,
  onResult = () => {},
  onError = () => {}
} = {}) {
  if (!repository || typeof repository.load !== 'function' || typeof repository.claimOutboxEvent !== 'function' || typeof repository.save !== 'function' || typeof repository.finishOutboxEvent !== 'function') throw new TypeError('A worker-capable memory repository is required');
  const eventTypes = derivedEventTypes(featureFlags);
  let stopped = true;
  let timer = null;
  let tickPromise = null;
  let lastRetentionSweepAt = 0;

  const runRetentionSweep = async ({ now = new Date(), limit = retentionSweepBatchSize } = {}) => {
    if (typeof repository.listRetentionSubjects !== 'function') return { status: 'unsupported' };
    const subjects = await repository.listRetentionSubjects({ now, limit });
    const results = [];
    for (const subject of subjects) {
      const context = { ...subject, actorType: 'system', actorId: workerId, callerAgentId: null };
      const state = await repository.load(subject);
      const memory = createMemoryModule(state, async () => {});
      const result = await memory.sweepRetention(context, { now });
      if (result.status === 'swept') await repository.save(subject, state);
      results.push({ tenantId: subject.tenantId, subjectUserId: subject.subjectUserId, ...result });
    }
    return { status: results.some(result => result.status === 'swept') ? 'swept' : 'noop', processed: results.length, results };
  };

  const runOnce = async ({ now = new Date() } = {}) => {
    if (!eventTypes.length) return { status: 'idle', reason: 'all_derived_features_disabled' };
    const claimed = await repository.claimOutboxEvent({ workerId, leaseMs, now, eventTypes, consumerName: 'memory-derived' });
    if (!claimed) return { status: 'idle' };
    const { event: claimedEvent, context } = claimed;
    const state = await repository.load(context);
    const event = state.outboxEvents?.find(item => item.id === claimedEvent.id);
    if (!event) {
      await repository.finishOutboxEvent({ eventId: claimedEvent.id, workerId, status: 'completed', result: 'redacted_before_load' });
      return { status: 'completed', eventId: claimedEvent.id, result: 'redacted_before_load' };
    }
    const memory = createMemoryModule(state, async () => {});
    const worker = createMemoryModuleWorker({
      state,
      workerId,
      maxAttempts,
      leaseMs,
      supportedSchemaVersions,
      persist: () => repository.save(context, state, { fenceEventId: event.id, fenceWorkerId: workerId }),
      processEvent: async ({ event: currentEvent, assertLease }) => {
        const sourceEvent = currentEvent.type === 'raw_event.created'
          ? state.rawEvents?.find(item => item.id === currentEvent.aggregateId)
          : null;
        const assertion = currentEvent.type === 'assertion.active'
          ? state.assertions?.find(item => item.id === currentEvent.aggregateId)
          : null;
        const guard = {
          sourceRevision: sourceEvent?.sourceRevision || null,
          sourceCommitSeq: sourceEvent?.commitSeq || currentEvent.commitSeq || null,
          aggregateRevision: sourceEvent?.resourceRevision || assertion?.resourceRevision || null,
          privacyEpoch: Number(state.redactionEpochs?.[`${currentEvent.tenantId}:${currentEvent.userId}`] || 0),
          policyEpoch: state.policyVersion || 'memory-policy-v1',
          grantVersion: Number(state.grantVersion || 0)
        };
        const assertInputFresh = () => {
          assertLease();
          const currentSource = sourceEvent ? state.rawEvents?.find(item => item.id === sourceEvent.id) : null;
          const currentAssertion = assertion ? state.assertions?.find(item => item.id === assertion.id) : null;
          const currentRevision = currentSource?.resourceRevision || currentAssertion?.resourceRevision || null;
          const currentPrivacyEpoch = Number(state.redactionEpochs?.[`${currentEvent.tenantId}:${currentEvent.userId}`] || 0);
          if ((sourceEvent && (!currentSource || currentSource.sourceRevision !== guard.sourceRevision || currentSource.commitSeq !== guard.sourceCommitSeq))
            || (guard.aggregateRevision != null && currentRevision !== guard.aggregateRevision)
            || currentPrivacyEpoch !== guard.privacyEpoch
            || (state.policyVersion || 'memory-policy-v1') !== guard.policyEpoch
            || Number(state.grantVersion || 0) !== guard.grantVersion) {
            const error = new Error('Worker input changed while processing');
            error.code = 'WORKER_INPUT_CHANGED';
            error.retryable = true;
            throw error;
          }
        };
        if (sourceEvent && isSupersededSourceEvent(state.rawEvents, sourceEvent)) return { status: 'superseded_revision' };
        assertInputFresh();
        let extraction = null;
        if (currentEvent.type === 'raw_event.created' && featureEnabled(featureFlags, 'autoExtract')) {
          extraction = await processExtractionEvent({
            state,
            memory,
            event: currentEvent,
            workerId,
            modelGateway,
            allowSensitiveModelInput,
            featureFlags,
            assertLease: assertInputFresh
          });
        }
        assertInputFresh();
        const derived = await rebuildDerivedState(state, { event: currentEvent, featureFlags, embeddingGateway });
        return { status: 'processed', extractionStatus: extraction?.status || null, candidateCount: extraction?.candidateCount || 0, ...derived };
      }
    });
    try {
      return await worker.runClaimed({ event, now });
    } catch (error) {
      const status = Number(event.attempts || 0) >= maxAttempts ? 'dead_letter' : 'pending';
      await repository.finishOutboxEvent({ eventId: event.id, workerId, status, errorCode: error.code || 'WORKER_PERSIST_FAILED' });
      return { status, eventId: event.id, errorCode: error.code || 'WORKER_PERSIST_FAILED', retryable: status === 'pending' };
    }
  };

  const tick = async () => {
    if (stopped) return;
    let processed = 0;
    let result = { status: 'idle' };
    try {
      const now = new Date();
      if (typeof repository.listRetentionSubjects === 'function' && now.getTime() - lastRetentionSweepAt >= retentionSweepIntervalMs) {
        const retention = await runRetentionSweep({ now });
        lastRetentionSweepAt = now.getTime();
        if (retention.processed) onResult({ ...retention, workerId });
      }
      while (!stopped && processed < batchSize) {
        result = await runOnce();
        if (result.status === 'idle') break;
        processed += 1;
        onResult({ ...result, workerId });
      }
    } catch (error) {
      onError(error);
    }
    if (!stopped) {
      timer = setTimeout(trackTick, processed ? 0 : pollIntervalMs);
      timer.unref?.();
    }
  };

  const trackTick = () => {
    const pending = tick();
    tickPromise = pending;
    pending.then(() => {
      if (tickPromise === pending) tickPromise = null;
    }, () => {
      if (tickPromise === pending) tickPromise = null;
    });
    return pending;
  };

  const start = () => {
    if (!stopped) return { workerId, eventTypes, status: 'running' };
    stopped = false;
    void trackTick();
    return { workerId, eventTypes, status: 'running' };
  };

  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (tickPromise) await tickPromise;
    return { workerId, status: 'stopped' };
  };

  return { workerId, eventTypes, runOnce, runRetentionSweep, start, stop, get running() { return !stopped; } };
}
