import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryModuleState } from './memory-module.js';
import { createMemoryModuleWorker } from './memory-module-worker.js';

const rawEvent = (id = 'raw-1') => ({ id, eventId: id, sourceRevision: '1', tenantId: 'tenant-a', userId: 'user-a', content: 'safe', createdAt: new Date().toISOString() });

test('worker claims, processes, and completes an outbox event with a lease', async () => {
  const state = createMemoryModuleState();
  state.rawEvents.push(rawEvent());
  state.outboxEvents.push({ id: 'outbox-1', type: 'raw_event.created', aggregateId: 'raw-1', status: 'pending', attempts: 0 });
  const processed = [];
  const worker = createMemoryModuleWorker({ state, workerId: 'worker-a', processEvent: async ({ event }) => { processed.push(event.id); return { status: 'candidate_deferred' }; } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.deepEqual(processed, ['outbox-1']);
  assert.equal(state.outboxEvents[0].status, 'completed');
  assert.equal(state.jobAttempts[0].status, 'completed');
});

test('worker dead-letters unknown outbox schema versions without invoking business processing', async () => {
  const state = createMemoryModuleState();
  state.outboxEvents.push({ id: 'unknown-schema-event', type: 'raw_event.created', aggregateId: 'raw-unknown', schemaVersion: 99, status: 'pending' });
  let processed = false;
  const worker = createMemoryModuleWorker({
    state,
    workerId: 'schema-worker',
    processEvent: async () => { processed = true; return { status: 'processed' }; },
    persist: async () => {}
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'dead_letter');
  assert.equal(result.errorCode, 'UNSUPPORTED_OUTBOX_SCHEMA');
  assert.equal(processed, false);
  assert.equal(state.outboxEvents[0].status, 'dead_letter');
  assert.equal(state.outboxEvents[0].result, 'unsupported_schema');
  assert.equal(state.jobAttempts[0].errorCode, 'UNSUPPORTED_OUTBOX_SCHEMA');
});

test('redaction fencing completes a stale event without processing its content', async () => {
  const state = createMemoryModuleState();
  state.rawEvents.push(rawEvent('raw-forgotten'));
  state.tombstones.push({ targetType: 'source_event', targetId: 'raw-forgotten', action: 'forget' });
  state.outboxEvents.push({ id: 'outbox-forgotten', type: 'raw_event.created', aggregateId: 'raw-forgotten', status: 'pending' });
  let called = false;
  const worker = createMemoryModuleWorker({ state, processEvent: async () => { called = true; } });
  const result = await worker.runOnce();
  assert.equal(result.result, 'redacted_before_processing');
  assert.equal(called, false);
  assert.equal(state.outboxEvents[0].status, 'completed');
});

test('worker retries failures and dead-letters after the configured attempt limit', async () => {
  const state = createMemoryModuleState();
  state.rawEvents.push(rawEvent('raw-failing'));
  state.outboxEvents.push({ id: 'outbox-failing', type: 'raw_event.created', aggregateId: 'raw-failing', status: 'pending' });
  const worker = createMemoryModuleWorker({ state, maxAttempts: 2, processEvent: async () => { throw Object.assign(new Error('temporary'), { code: 'MODEL_UNAVAILABLE' }); } });
  const first = await worker.runOnce();
  assert.equal(first.status, 'pending');
  const second = await worker.runOnce();
  assert.equal(second.status, 'dead_letter');
  assert.equal(state.outboxEvents[0].attempts, 2);
  assert.equal(state.jobAttempts[1].errorCode, 'MODEL_UNAVAILABLE');
});

test('expired leases are reclaimable and a stale completion is fenced', async () => {
  const state = createMemoryModuleState();
  state.rawEvents.push(rawEvent('raw-lease'));
  state.outboxEvents.push({ id: 'outbox-lease', type: 'raw_event.created', aggregateId: 'raw-lease', status: 'processing', leaseOwner: 'worker-old', leaseUntil: '2020-01-01T00:00:00.000Z', attempts: 1 });
  const worker = createMemoryModuleWorker({ state, workerId: 'worker-new', processEvent: async ({ assertLease }) => { assertLease(); return { status: 'ok' }; } });
  const controlledNow = new Date('2026-08-22T00:00:00.000Z');
  const result = await worker.runOnce({ now: controlledNow, clock: () => controlledNow });
  assert.equal(result.status, 'completed');
  assert.equal(state.outboxEvents[0].leaseOwner, null);
});

test('worker fences a completion after the live lease expires during processing', async () => {
  const state = createMemoryModuleState();
  state.rawEvents.push(rawEvent('raw-live-expiry'));
  state.outboxEvents.push({ id: 'outbox-live-expiry', type: 'raw_event.created', aggregateId: 'raw-live-expiry', status: 'pending' });
  const worker = createMemoryModuleWorker({ state, leaseMs: 1, processEvent: async ({ assertLease }) => {
    await new Promise(resolve => setTimeout(resolve, 5));
    assertLease();
    return { status: 'should_not_commit' };
  } });
  const result = await worker.runOnce();
  assert.equal(result.status, 'fenced');
  assert.equal(state.outboxEvents[0].status, 'pending');
});
