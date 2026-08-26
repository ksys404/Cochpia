import { randomUUID } from 'node:crypto';

const EVENT_TYPES = new Set(['anniversary', 'birthday', 'plan', 'record']);

function normalizeTitle(value) {
  const title = String(value || '').trim();
  if (!title) throw new Error('Event title is required');
  return title.slice(0, 160);
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === '') throw new Error('Event date is required');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Event date must be a valid date');
  return date.toISOString();
}

export function createEventService(state, persist, { onMutation = null, onMutationRollback = null } = {}) {
  state.events ||= [];
  const find = id => state.events.find(event => event.id === id) || null;
  const notify = mutation => typeof onMutation === 'function' ? onMutation(mutation) : null;
  const rollbackMutation = async (mutation, notification) => {
    if (typeof onMutationRollback !== 'function') return;
    try { await onMutationRollback({ mutation, notification }); } catch { /* preserve the original mutation error */ }
  };

  return {
    list({ type, upcomingDays } = {}) {
      let items = state.events.slice();
      if (type) items = items.filter(event => event.type === type);
      if (upcomingDays) {
        const now = new Date();
        const until = new Date(now.getTime() + Number(upcomingDays) * 86400000);
        items = items.filter(event => {
          const date = new Date(event.date);
          return date >= now && date <= until;
        });
      }
      return items.sort((a, b) => new Date(a.date) - new Date(b.date));
    },
    listUpcoming(days = 7) {
      const now = new Date();
      const until = new Date(now.getTime() + Number(days) * 86400000);
      return state.events
        .filter(event => { const date = new Date(event.date); return date >= now && date <= until; })
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map(event => ({ id: event.id, type: event.type, title: event.title, date: event.date, note: event.note }));
    },
    get(id) { return find(id); },
    create(input = {}) {
      const type = input.type || 'plan';
      if (!EVENT_TYPES.has(type)) throw new Error('Invalid event type');
      const now = new Date().toISOString();
      const event = {
        id: randomUUID(),
        type,
        title: normalizeTitle(input.title),
        date: normalizeDate(input.date),
        note: String(input.note || '').trim().slice(0, 500),
        visibility: input.visibility || 'shared',
        createdAt: now,
        updatedAt: now
      };
      state.events.push(event);
      const mutation = { mutationId: randomUUID(), action: 'created', event: structuredClone(event), previous: null };
      return (async () => {
        let notification = null;
        try {
          notification = await notify(mutation);
          await persist();
          return event;
        } catch (error) {
          const index = state.events.findIndex(item => item.id === event.id);
          if (index !== -1) state.events.splice(index, 1);
          await rollbackMutation(mutation, notification);
          throw error;
        }
      })();
    },
    update(id, input = {}) {
      const event = find(id);
      if (!event) return null;
      const previous = structuredClone(event);
      if (input.title !== undefined) event.title = normalizeTitle(input.title);
      if (input.date !== undefined) event.date = normalizeDate(input.date);
      if (input.type !== undefined) {
        if (!EVENT_TYPES.has(input.type)) throw new Error('Invalid event type');
        event.type = input.type;
      }
      if (input.note !== undefined) event.note = String(input.note || '').trim().slice(0, 500);
      if (input.visibility !== undefined) event.visibility = String(input.visibility).slice(0, 40);
      event.updatedAt = new Date().toISOString();
      const mutation = { mutationId: randomUUID(), action: 'updated', event: structuredClone(event), previous };
      return (async () => {
        let notification = null;
        try {
          notification = await notify(mutation);
          await persist();
          return event;
        } catch (error) {
          Object.assign(event, previous);
          await rollbackMutation(mutation, notification);
          throw error;
        }
      })();
    },
    remove(id) {
      const index = state.events.findIndex(event => event.id === id);
      if (index === -1) return false;
      const removed = structuredClone(state.events[index]);
      state.events.splice(index, 1);
      const mutation = { mutationId: randomUUID(), action: 'deleted', event: removed, previous: removed };
      return (async () => {
        let notification = null;
        try {
          notification = await notify(mutation);
          await persist();
          return true;
        } catch (error) {
          state.events.splice(index, 0, removed);
          await rollbackMutation(mutation, notification);
          throw error;
        }
      })();
    }
  };
}

export { EVENT_TYPES };
