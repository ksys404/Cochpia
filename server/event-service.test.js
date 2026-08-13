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
