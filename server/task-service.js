import { randomUUID } from 'node:crypto';

const statuses = new Set(['open', 'in_progress', 'completed', 'cancelled']);

function normalizeDueAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('dueAt must be a valid date');
  return date.toISOString();
}

function normalizeTitle(value) {
  const title = String(value || '').trim();
  if (!title) throw new Error('Task title is required');
  return title.slice(0, 160);
}

export function createTaskService(state, persist) {
  state.tasks ||= [];
  const find = id => state.tasks.find(task => task.id === id) || null;
  return {
    list({ status, sessionId, overdue = false, search = '', limit = 50 } = {}) {
      const normalizedSearch = String(search || '').trim().toLowerCase();
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
      return state.tasks
        .filter(task => !status || task.status === status)
        .filter(task => !sessionId || task.sessionId === sessionId)
        .filter(task => !overdue || (task.dueAt && new Date(task.dueAt).getTime() < Date.now() && !['completed', 'cancelled'].includes(task.status)))
        .filter(task => !normalizedSearch || `${task.title} ${task.description || ''}`.toLowerCase().includes(normalizedSearch))
        .sort((a, b) => (a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER) - (b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER) || new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, safeLimit);
    },
    get(id) { return find(id); },
    create(input = {}) {
      const now = new Date().toISOString();
      const task = { id: randomUUID(), title: normalizeTitle(input.title), description: String(input.description || '').trim().slice(0, 1000), status: input.status || 'open', sessionId: input.sessionId || null, dueAt: normalizeDueAt(input.dueAt), createdAt: now, updatedAt: now, completedAt: null };
      if (!statuses.has(task.status)) throw new Error('Invalid task status');
      state.tasks.unshift(task);
      return persist().then(() => task);
    },
    update(id, input = {}) {
      const task = find(id);
      if (!task) return null;
      if (input.title !== undefined) task.title = normalizeTitle(input.title);
      if (input.description !== undefined) task.description = String(input.description || '').trim().slice(0, 1000);
      if (input.sessionId !== undefined) task.sessionId = input.sessionId || null;
      if (input.dueAt !== undefined) task.dueAt = normalizeDueAt(input.dueAt);
      if (input.status !== undefined) {
        if (!statuses.has(input.status)) throw new Error('Invalid task status');
        task.status = input.status;
        task.completedAt = input.status === 'completed' ? new Date().toISOString() : null;
      }
      task.updatedAt = new Date().toISOString();
      return persist().then(() => task);
    },
    remove(id) {
      const index = state.tasks.findIndex(task => task.id === id);
      if (index === -1) return false;
      state.tasks.splice(index, 1);
      return persist().then(() => true);
    }
  };
}

export { statuses };
