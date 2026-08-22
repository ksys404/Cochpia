import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';
import { createMemoryExtractionWorker } from './memory-module-extraction-worker.js';

const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'user', actorId: 'user-a' };

test('extraction worker turns a final raw event into a source-linked candidate', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  const event = await memory.recordEvent(context, { eventId: 'evt-worker', content: '请记住我喜欢红茶', isStreamFinal: true });
  const worker = createMemoryExtractionWorker({ state, memory, workerId: 'extractor-a' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(state.assertions.length, 1);
  assert.equal(state.assertions[0].status, 'candidate');
  assert.equal(state.assertionVersionSources[0].sourceId, event.rawEventId);
});

test('extraction worker does not create duplicate candidates for a repeated outbox event', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'evt-dup-worker', content: '请记住我喜欢咖啡' });
  const worker = createMemoryExtractionWorker({ state, memory, workerId: 'extractor-a' });
  await worker.runOnce();
  state.outboxEvents.push({ id: 'repeat', type: 'raw_event.created', aggregateId: state.rawEvents[0].id, status: 'pending' });
  const repeated = await worker.runOnce();
  assert.equal(repeated.status, 'completed');
  assert.equal(state.assertions.length, 1);
});

test('model failure leaves extraction outbox pending without activating memory', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'evt-model-fail', content: '请记住我喜欢爵士乐' });
  const worker = createMemoryExtractionWorker({ state, memory, workerId: 'extractor-a', modelGateway: { extract: async () => { throw Object.assign(new Error('model down'), { code: 'MODEL_UNAVAILABLE' }); } } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'pending');
  assert.equal(state.assertions.length, 0);
});

test('auto extraction feature flag defers rather than consumes the outbox event', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  await memory.recordEvent(context, { eventId: 'evt-feature-off', content: '请记住我喜欢爵士乐' });
  const worker = createMemoryExtractionWorker({ state, memory, workerId: 'extractor-a', featureFlags: { autoExtract: false } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(state.outboxEvents[0].status, 'pending');
  assert.equal(state.outboxEvents[0].result, 'feature_disabled');
  assert.equal(state.assertions.length, 0);
});

test('extraction worker fences a non-final event even if an old outbox row exists', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state);
  const event = await memory.recordEvent(context, { eventId: 'evt-draft-worker', content: '草稿请记住红茶', isStreamFinal: false });
  state.outboxEvents.push({ id: 'legacy-draft-outbox', type: 'raw_event.created', aggregateId: event.rawEventId, status: 'pending', attempts: 0 });
  const worker = createMemoryExtractionWorker({ state, memory, workerId: 'extractor-a' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.result, 'awaiting_finalization');
  assert.equal(state.assertions.length, 0);
});

test('extraction worker completes an old revision without generating a candidate', async () => {
  const state = createMemoryModuleState();
  const memory = createMemoryModule(state, async () => {});
  const old = await memory.recordEvent(context, { eventId: 'evt-revision-worker', sourceRevision: '1', content: '请记住旧版本喜欢红茶' });
  await memory.recordEvent(context, { eventId: 'evt-revision-worker', sourceRevision: '2', content: '请记住新版本喜欢咖啡' });
  const worker = createMemoryExtractionWorker({ state, memory, workerId: 'extractor-a' });
  const first = await worker.runOnce();
  assert.equal(first.result, 'superseded_revision');
  assert.equal(state.assertions.length, 0);
  const second = await worker.runOnce();
  assert.equal(second.status, 'completed');
  assert.equal(state.assertions.length, 1);
  assert.equal(state.assertionVersions[0].content, '请记住新版本喜欢咖啡');
  assert.ok(old.rawEventId);
});
