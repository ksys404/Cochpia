import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventService } from './event-service.js';

test('event service creates, lists upcoming, updates, and removes events', async () => {
  const state = {};
  const service = createEventService(state, async () => {});
  const future = new Date(Date.now() + 3 * 86400000).toISOString();
  const past = new Date(Date.now() - 3 * 86400000).toISOString();
  const upcoming = await service.create({ title: '纪念日', type: 'anniversary', date: future, note: '很特别' });
  await service.create({ title: '过去的计划', type: 'plan', date: past });
  assert.equal(service.list().length, 2);
  assert.equal(service.listUpcoming(7).length, 1);
  assert.equal(service.listUpcoming(7)[0].id, upcoming.id);
  const updated = await service.update(upcoming.id, { title: '改名纪念日' });
  assert.equal(updated.title, '改名纪念日');
  assert.equal(await service.remove(upcoming.id), true);
  assert.equal(service.list().length, 1);
});

test('event service rejects invalid types, dates, and empty titles', async () => {
  const service = createEventService({}, async () => {});
  assert.throws(() => service.create({ title: 'x', date: new Date().toISOString(), type: 'nope' }), /Invalid event type/);
  assert.throws(() => service.create({ title: 'x', date: 'not-a-date' }), /valid date/);
  assert.throws(() => service.create({ title: '', date: new Date().toISOString() }), /title/);
});

test('calendar mutations expose a durable interaction hook', async () => {
  const state = {};
  const mutations = [];
  const service = createEventService(state, async () => {}, { onMutation: mutation => mutations.push(mutation) });
  const event = await service.create({ title: 'Shared walk', date: '2026-08-30T10:00:00.000Z' });
  await service.update(event.id, { note: 'Bring tea' });
  await service.remove(event.id);
  assert.deepEqual(mutations.map(item => item.action), ['created', 'updated', 'deleted']);
  assert.equal(new Set(mutations.map(item => item.mutationId)).size, 3);
  assert.equal(mutations[0].event.id, event.id);
  assert.equal(mutations[1].previous.note, '');
  assert.equal(mutations[2].event.title, 'Shared walk');
});

test('calendar creation rolls back when the interaction ingress cannot be queued', async () => {
  const state = {};
  const service = createEventService(state, async () => {
    throw new Error('persist must not run after enqueue failure');
  }, {
    onMutation: () => { throw Object.assign(new Error('outbox unavailable'), { code: 'OUTBOX_UNAVAILABLE', status: 503 }); }
  });
  await assert.rejects(() => service.create({ title: 'No orphan event', date: '2026-08-30T10:00:00.000Z' }), error => error.code === 'OUTBOX_UNAVAILABLE');
  assert.equal(state.events.length, 0);
});

test('calendar update and deletion roll back when persistence fails after enqueue', async () => {
  const state = { events: [{ id: 'event-rollback', type: 'plan', title: 'Original', date: '2026-08-30T10:00:00.000Z', note: '', visibility: 'shared', createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z' }] };
  const rollbacks = [];
  const service = createEventService(state, async () => { throw Object.assign(new Error('storage unavailable'), { code: 'STORAGE_UNAVAILABLE', status: 503 }); }, {
    onMutation: mutation => ({ id: `outbox-${mutation.action}`, newlyEnqueued: true }),
    onMutationRollback: input => { rollbacks.push(input.notification.id); }
  });
  await assert.rejects(() => service.update('event-rollback', { title: 'Changed' }), error => error.code === 'STORAGE_UNAVAILABLE');
  assert.equal(state.events[0].title, 'Original');
  await assert.rejects(() => service.remove('event-rollback'), error => error.code === 'STORAGE_UNAVAILABLE');
  assert.equal(state.events.length, 1);
  assert.deepEqual(rollbacks, ['outbox-updated', 'outbox-deleted']);
});
