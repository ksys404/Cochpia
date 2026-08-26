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

test('task mutations expose a durable interaction hook after the domain mutation is shaped', async () => {
  const state = { tasks: [] };
  const mutations = [];
  const service = createTaskService(state, async () => {}, { onMutation: mutation => mutations.push(mutation) });
  const task = await service.create({ title: 'Remember tea' });
  await service.update(task.id, { status: 'completed' });
  await service.remove(task.id);
  assert.deepEqual(mutations.map(item => item.action), ['created', 'updated', 'deleted']);
  assert.equal(new Set(mutations.map(item => item.mutationId)).size, 3);
  assert.equal(mutations[0].task.id, task.id);
  assert.equal(mutations[1].previous.status, 'open');
  assert.equal(mutations[2].task.title, 'Remember tea');
});

test('task creation rolls back when the interaction ingress cannot be queued', async () => {
  const state = { tasks: [] };
  const service = createTaskService(state, async () => {
    throw new Error('persist must not run after enqueue failure');
  }, {
    onMutation: () => { throw Object.assign(new Error('outbox unavailable'), { code: 'OUTBOX_UNAVAILABLE', status: 503 }); }
  });
  await assert.rejects(() => service.create({ title: 'No orphan task' }), error => error.code === 'OUTBOX_UNAVAILABLE');
  assert.equal(state.tasks.length, 0);
});

test('task update and deletion roll back when persistence fails after enqueue', async () => {
  const state = { tasks: [{ id: 'task-rollback', title: 'Original', description: '', status: 'open', sessionId: null, dueAt: null, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', completedAt: null }] };
  const rollbacks = [];
  const service = createTaskService(state, async () => { throw Object.assign(new Error('storage unavailable'), { code: 'STORAGE_UNAVAILABLE', status: 503 }); }, {
    onMutation: mutation => ({ id: `outbox-${mutation.action}`, newlyEnqueued: true }),
    onMutationRollback: input => { rollbacks.push(input.notification.id); }
  });
  await assert.rejects(() => service.update('task-rollback', { title: 'Changed' }), error => error.code === 'STORAGE_UNAVAILABLE');
  assert.equal(state.tasks[0].title, 'Original');
  await assert.rejects(() => service.remove('task-rollback'), error => error.code === 'STORAGE_UNAVAILABLE');
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(rollbacks, ['outbox-updated', 'outbox-deleted']);
});
