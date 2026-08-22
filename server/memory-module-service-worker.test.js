import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleServiceWorker } from './memory-module-service-worker.js';

const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'user', actorId: 'user-a', callerAgentId: 'cochpia' };

function fakeRepository(state) {
  return {
    async claimOutboxEvent({ workerId, leaseMs = 30_000, eventTypes = null } = {}) {
      const event = state.outboxEvents.find(item => item.status === 'pending' && (!eventTypes?.length || eventTypes.includes(item.type)));
      if (!event) return null;
      event.status = 'processing';
      event.leaseOwner = workerId;
      event.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      event.attempts = Number(event.attempts || 0) + 1;
      return { event: structuredClone(event), context };
    },
    async load() { return state; },
    async save() { state.persistenceBaseSequence = state.sequence; },
    async finishOutboxEvent({ eventId, workerId, status, errorCode = null } = {}) {
      const event = state.outboxEvents.find(item => item.id === eventId && item.leaseOwner === workerId);
      if (!event) return { updated: false, eventId, status };
      event.status = status;
      event.lastErrorCode = errorCode;
      event.leaseOwner = null;
      event.leaseUntil = null;
      return { updated: true, eventId, status };
    }
  };
}

test('service worker does not claim events when every derived feature is disabled', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'event-disabled', content: '请记住我喜欢红茶' });
  const worker = createMemoryModuleServiceWorker({ repository: fakeRepository(state), featureFlags: { autoExtract: false, autoProfileUpdate: false, hybridRetrieval: false, vectorRetrieval: false, episodeGrouping: false, proactiveMention: false } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'idle');
  assert.equal(state.outboxEvents[0].status, 'pending');
});

test('service worker wires extraction and episode grouping behind independent flags', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'event-derived', content: '请记住我喜欢红茶', sessionId: null });
  const worker = createMemoryModuleServiceWorker({
    repository: fakeRepository(state),
    featureFlags: { autoExtract: true, autoProfileUpdate: false, hybridRetrieval: false, vectorRetrieval: false, episodeGrouping: true, proactiveMention: false }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(state.outboxEvents[0].status, 'completed');
  assert.equal(state.assertions.length, 1);
  assert.equal(state.episodes.length, 1);
  assert.equal(state.episodeMembers.length, 1);
});

test('service worker rebuilds profile and lexical index only when their flags are enabled', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.hold(context, { content: '喜欢蓝色', sensitivity: 'S0', memoryType: 'preference' });
  const worker = createMemoryModuleServiceWorker({
    repository: fakeRepository(state),
    featureFlags: { autoExtract: false, autoProfileUpdate: true, hybridRetrieval: true, vectorRetrieval: false, episodeGrouping: false, proactiveMention: false }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(state.outboxEvents[0].status, 'completed');
  assert.equal(state.indexDocuments.length, 1);
  assert.equal(state.profileProjections.filter(item => item.status === 'active' && item.scopeType === 'user').length, 1);
  assert.equal(state.profileProjectionItems.length, 1);
});

test('service worker uses a dedicated embedding gateway for index rebuilds', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.hold(context, { content: '喜欢绿色', sensitivity: 'S0', memoryType: 'preference' });
  const worker = createMemoryModuleServiceWorker({
    repository: fakeRepository(state),
    featureFlags: { autoExtract: false, autoProfileUpdate: false, hybridRetrieval: true, vectorRetrieval: false, episodeGrouping: false, proactiveMention: false },
    modelGateway: { extract: async () => { throw new Error('extraction gateway must not be used'); } },
    embeddingGateway: { embed: async () => [0.25, 0.75] }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(state.indexDocuments[0].embedding, [0.25, 0.75]);
  assert.equal(state.indexDocuments[0].embeddingVersion, 'gateway-v1');
});

test('service worker fences derived output when privacy input changes during extraction', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'event-input-changed', content: '请记住我喜欢红茶' });
  const repository = fakeRepository(state);
  const worker = createMemoryModuleServiceWorker({
    repository,
    featureFlags: { autoExtract: true, autoProfileUpdate: false, hybridRetrieval: false, vectorRetrieval: false, episodeGrouping: false, proactiveMention: false },
    modelGateway: { extract: async () => {
      state.redactionEpochs['tenant-a:user-a'] = 1;
      return [{ content: '喜欢红茶', sensitivity: 'S0' }];
    } }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'pending');
  assert.equal(result.errorCode, 'WORKER_INPUT_CHANGED');
  assert.equal(state.assertions.length, 0);
});

test('service worker discovers and persists retention sweeps independently of derived feature flags', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  const event = await memory.recordEvent(context, { eventId: 'retention-worker-event', content: '到期来源' });
  const now = new Date(Date.now() + 60_000);
  state.rawEvents.find(item => item.id === event.rawEventId).deleteAfter = now.toISOString();
  const baseRepository = fakeRepository(state);
  const repository = {
    ...baseRepository,
    async listRetentionSubjects() { return [context]; }
  };
  const worker = createMemoryModuleServiceWorker({
    repository,
    featureFlags: { autoExtract: false, autoProfileUpdate: false, hybridRetrieval: false, vectorRetrieval: false, episodeGrouping: false, proactiveMention: false }
  });
  const result = await worker.runRetentionSweep({ now });
  assert.equal(result.status, 'swept');
  assert.equal(state.rawEvents.length, 0);
  assert.equal(state.persistenceBaseSequence, state.sequence);
});

test('service worker passes the claimed outbox lease to PostgreSQL state saves', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'fenced-save-event', content: '请记住我喜欢红茶' });
  const baseRepository = fakeRepository(state);
  const fences = [];
  const repository = {
    ...baseRepository,
    async save(_context, _state, options) { fences.push(options); }
  };
  const worker = createMemoryModuleServiceWorker({
    repository,
    featureFlags: { autoExtract: true, autoProfileUpdate: false, hybridRetrieval: false, vectorRetrieval: false, episodeGrouping: false, proactiveMention: false },
    workerId: 'fenced-worker'
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(fences.length > 0, true);
  assert.equal(fences[0].fenceWorkerId, 'fenced-worker');
  assert.equal(fences[0].fenceEventId, state.outboxEvents[0].id);
});
