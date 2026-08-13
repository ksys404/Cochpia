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

export function createEventService(state, persist) {
  state.events ||= [];
  const find = id => state.events.find(event => event.id === id) || null;

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
      return persist().then(() => event);
    },
    update(id, input = {}) {
      const event = find(id);
      if (!event) return null;
      if (input.title !== undefined) event.title = normalizeTitle(input.title);
      if (input.date !== undefined) event.date = normalizeDate(input.date);
      if (input.type !== undefined) {
        if (!EVENT_TYPES.has(input.type)) throw new Error('Invalid event type');
        event.type = input.type;
      }
      if (input.note !== undefined) event.note = String(input.note || '').trim().slice(0, 500);
      if (input.visibility !== undefined) event.visibility = String(input.visibility).slice(0, 40);
      event.updatedAt = new Date().toISOString();
      return persist().then(() => event);
    },
    remove(id) {
      const index = state.events.findIndex(event => event.id === id);
      if (index === -1) return false;
      state.events.splice(index, 1);
      return persist().then(() => true);
    }
  };
}

export { EVENT_TYPES };
