import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventService, nextOccurrence } from './events.js';
import { buildRuntimeContext } from './runtime-context.js';
import { createModelProvider } from './model-provider.js';

// 固定「今天」,保证 daysUntil 断言不随时钟漂移。
const NOW = Date.parse('2026-09-11T10:30:00Z');

test('events round-trip: create, list, update, remove', async () => {
  const state = {};
  let persists = 0;
  const events = createEventService(state, async () => { persists += 1; });

  const created = await events.create({ title: '初次相遇', date: '2026-09-13', type: 'anniversary', note: '  玻璃城  ' }, { now: NOW });
  assert.equal(created.title, '初次相遇');
  assert.equal(created.note, '玻璃城');
  assert.equal(created.recurring, true);
  assert.equal(created.daysUntil, 2);
  assert.equal(persists, 1);
  assert.equal(state.events.length, 1);

  assert.deepEqual(events.list({ now: NOW }).map(item => item.id), [created.id]);

  const updated = await events.update(created.id, { date: '2026-09-12' }, { now: NOW });
  assert.equal(updated.daysUntil, 1);
  assert.equal(persists, 2);

  assert.equal(await events.remove(created.id), true);
  assert.equal(await events.remove(created.id), false);
  assert.deepEqual(events.list({ now: NOW }), []);
});

test('events validate title, date and type', async () => {
  const events = createEventService({});
  await assert.rejects(() => events.create({ date: '2026-09-13' }), /title/i);
  await assert.rejects(() => events.create({ title: 'x', date: '2026-02-31' }), /date/i);
  await assert.rejects(() => events.create({ title: 'x', date: '2026-09-13', type: 'unknown' }), /type/i);
  const fallback = await events.create({ title: 'x', date: '2026-09-13' });
  assert.equal(fallback.type, 'plan');
});

test('recurring events roll forward to the next occurrence', () => {
  assert.equal(nextOccurrence({ type: 'birthday', date: '2000-03-01' }, NOW), Date.parse('2027-03-01T00:00:00Z'));
  assert.equal(nextOccurrence({ type: 'anniversary', date: '2026-09-11' }, NOW), Date.parse('2026-09-11T00:00:00Z'));
  assert.equal(nextOccurrence({ type: 'plan', date: '2020-01-01' }, NOW), Date.parse('2020-01-01T00:00:00Z'));
  assert.equal(nextOccurrence({ type: 'plan', date: 'not-a-date' }, NOW), null);
});

test('upcoming events are scoped to the agent and skip records', async () => {
  const events = createEventService({});
  await events.create({ title: '全局计划', date: '2026-09-14', type: 'plan' }, { now: NOW });
  await events.create({ title: '甲的纪念日', date: '2026-09-13', type: 'anniversary', agentId: 'agent-a' }, { now: NOW });
  await events.create({ title: '乙的纪念日', date: '2026-09-12', type: 'anniversary', agentId: 'agent-b' }, { now: NOW });
  await events.create({ title: '太远', date: '2026-10-30', type: 'plan' }, { now: NOW });
  await events.create({ title: '往年的记录', date: '2026-09-10', type: 'record' }, { now: NOW });

  assert.deepEqual(events.listUpcoming({ agentId: 'agent-a', days: 7, now: NOW }).map(item => item.title), ['甲的纪念日', '全局计划']);
  assert.deepEqual(events.listUpcoming({ agentId: 'agent-x', days: 7, now: NOW }).map(item => item.title), ['全局计划']);
  assert.deepEqual(events.listUpcoming({ days: 7, now: NOW }).map(item => item.title), ['全局计划']);
});

test('events are filtered by owner', async () => {
  const events = createEventService({});
  await events.create({ title: 'A 的', date: '2026-09-13' }, { ownerId: 'user-a', now: NOW });
  await events.create({ title: 'B 的', date: '2026-09-14' }, { ownerId: 'user-b', now: NOW });

  const mine = events.list({ ownerId: 'user-a', now: NOW });
  assert.deepEqual(mine.map(item => item.title), ['A 的']);
  assert.equal(await events.remove(mine[0].id, { ownerId: 'user-b' }), false);
  assert.equal(await events.remove(mine[0].id, { ownerId: 'user-a' }), true);
  assert.deepEqual(events.list({ ownerId: 'user-b', now: NOW }).map(item => item.title), ['B 的']);
});

test('list sorts by proximity and honours limit', async () => {
  const events = createEventService({});
  await events.create({ title: '晚', date: '2026-09-20' }, { now: NOW });
  await events.create({ title: '早', date: '2026-09-12' }, { now: NOW });
  assert.deepEqual(events.list({ now: NOW }).map(item => item.title), ['早', '晚']);
  assert.equal(events.list({ limit: 1, now: NOW }).length, 1);
});

// 这个功能存在的意义就是把日程喂进系统提示,所以端到端验一次拼装结果。
test('upcoming events reach the companion system prompt', async () => {
  const events = createEventService({});
  await events.create({ title: '初次相遇', date: '2026-09-13', type: 'anniversary', note: '玻璃城' }, { now: NOW });
  await events.create({ title: '下周的计划', date: '2026-09-25', type: 'plan' }, { now: NOW });

  const runtimeContext = buildRuntimeContext({ messages: [], upcomingEvents: events.listUpcoming({ days: 7, now: NOW }) });
  const prompt = createModelProvider('openai', { apiKey: 'fixture', model: 'fixture' }).composeSystemPrompt({ recalled: [], runtimeContext });

  assert.match(prompt, /临近日程/);
  assert.match(prompt, /初次相遇/);
  assert.match(prompt, /玻璃城/);
  assert.doesNotMatch(prompt, /下周的计划/);
});
