import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskService } from './task-service.js';

test('task service creates, filters overdue tasks, and completes explicitly', async () => {
  const state = { tasks: [] };
  const service = createTaskService(state, async () => {});
  const overdue = await service.create({ title: 'Review memory', dueAt: '2020-01-01T00:00:00.000Z' });
  await service.create({ title: 'Future task', dueAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(service.list({ overdue: true }).length, 1);
  const completed = await service.update(overdue.id, { status: 'completed' });
  assert.equal(completed.completedAt !== null, true);
  assert.equal(service.list({ overdue: true }).length, 0);
});

test('task service rejects invalid fields without adding a task', async () => {
  const state = { tasks: [] };
  const service = createTaskService(state, async () => {});
  assert.throws(() => service.create({ title: '', status: 'open' }), /Task title is required/);
  assert.throws(() => service.create({ title: 'Bad date', dueAt: 'not-a-date' }), /valid date/);
  assert.throws(() => service.create({ title: 'Bad status', status: 'paused' }), /Invalid task status/);
  assert.equal(state.tasks.length, 0);
});
