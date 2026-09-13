import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = Object.freeze(['anniversary', 'birthday', 'plan', 'record']);
export const RECURRING_EVENT_TYPES = Object.freeze(['anniversary', 'birthday']);
export const DEFAULT_UPCOMING_DAYS = 7;
export const MAX_EVENTS_PER_USER = 500;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 80;
const MAX_NOTE_LENGTH = 300;
const MAX_AGENT_ID_LENGTH = 100;

const eventError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const isRecurring = type => RECURRING_EVENT_TYPES.includes(type);
const normalizeText = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

// 日期一律按 UTC 日界处理,避免服务器时区影响「还有几天」的计算。
const utcDayStart = value => {
  const date = value instanceof Date ? value : new Date(Number(value));
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const normalizeDate = value => {
  const text = String(value ?? '').trim();
  if (!DATE_ONLY.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  // 拒绝 2026-02-31 这类会被 Date 静默滚到下个月的日期
  return new Date(time).toISOString().slice(0, 10) === text ? text : null;
};

/** 纪念日/生日按年重复,返回「今天(含)之后最近的一次」;计划与记录只返回原始日期。 */
export function nextOccurrence(event, now = Date.now()) {
  const time = Date.parse(`${event?.date}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  const today = utcDayStart(now);
  if (!isRecurring(event.type)) return time;
  const source = new Date(time);
  const currentYear = new Date(today).getUTCFullYear();
  const thisYear = Date.UTC(currentYear, source.getUTCMonth(), source.getUTCDate());
  return thisYear < today ? Date.UTC(currentYear + 1, source.getUTCMonth(), source.getUTCDate()) : thisYear;
}

export function createEventService(state, persist = async () => {}) {
  // 按请求解析:每个用户态是独立克隆,首次访问时才落 state.events。
  const all = () => {
    state.events ||= [];
    return state.events;
  };
  const ownedBy = ownerId => all().filter(event => !ownerId || !event.ownerId || event.ownerId === ownerId);

  const decorate = (event, now) => {
    const occursAt = nextOccurrence(event, now);
    return {
      ...event,
      recurring: isRecurring(event.type),
      occursAt: occursAt == null ? null : new Date(occursAt).toISOString(),
      daysUntil: occursAt == null ? null : Math.round((occursAt - utcDayStart(now)) / DAY_MS)
    };
  };

  const sortForList = (a, b) => {
    const left = a.occursAt ? Date.parse(a.occursAt) : Number.MAX_SAFE_INTEGER;
    const right = b.occursAt ? Date.parse(b.occursAt) : Number.MAX_SAFE_INTEGER;
    return left - right || Date.parse(b.createdAt) - Date.parse(a.createdAt);
  };

  const normalizePatch = (input = {}, { partial = false } = {}) => {
    const patch = {};
    if (!partial || input.title !== undefined) {
      const title = normalizeText(input.title, MAX_TITLE_LENGTH);
      if (!title) throw eventError('EVENT_TITLE_REQUIRED', 'Event title is required');
      patch.title = title;
    }
    if (!partial || input.date !== undefined) {
      const date = normalizeDate(input.date);
      if (!date) throw eventError('EVENT_DATE_INVALID', 'Event date must be a valid YYYY-MM-DD date');
      patch.date = date;
    }
    if (!partial || input.type !== undefined) {
      if (input.type !== undefined && !EVENT_TYPES.includes(input.type)) throw eventError('EVENT_TYPE_INVALID', `Event type must be one of ${EVENT_TYPES.join(', ')}`);
      patch.type = EVENT_TYPES.includes(input.type) ? input.type : 'plan';
    }
    if (!partial || input.note !== undefined) patch.note = normalizeText(input.note, MAX_NOTE_LENGTH);
    if (input.agentId !== undefined) patch.agentId = input.agentId ? String(input.agentId).slice(0, MAX_AGENT_ID_LENGTH) : null;
    return patch;
  };

  return {
    list({ ownerId = null, limit = 200, now = Date.now() } = {}) {
      const safeLimit = Math.max(1, Math.min(MAX_EVENTS_PER_USER, Number(limit) || 200));
      return ownedBy(ownerId).map(event => decorate(event, now)).sort(sortForList).slice(0, safeLimit);
    },

    /**
     * 注入对话上下文的「临近日程」。
     * 按 Agent 隔离:未绑定 agentId 的事件对所有 Agent 可见,绑定到某个 Agent 的只对它自己可见。
     */
    listUpcoming({ ownerId = null, agentId = null, days = DEFAULT_UPCOMING_DAYS, now = Date.now() } = {}) {
      const horizon = Math.max(0, Number(days) || 0);
      return ownedBy(ownerId)
        .filter(event => !event.agentId || event.agentId === agentId)
        .filter(event => event.type !== 'record')
        .map(event => decorate(event, now))
        .filter(event => event.daysUntil !== null && event.daysUntil >= 0 && event.daysUntil <= horizon)
        .sort((a, b) => a.daysUntil - b.daysUntil || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    get(id, { ownerId = null, now = Date.now() } = {}) {
      const event = ownedBy(ownerId).find(item => item.id === id) || null;
      return event ? decorate(event, now) : null;
    },

    async create(input = {}, { ownerId = null, now = Date.now() } = {}) {
      const list = all();
      if (ownedBy(ownerId).length >= MAX_EVENTS_PER_USER) {
        throw eventError('EVENT_LIMIT_REACHED', `At most ${MAX_EVENTS_PER_USER} events are supported`, 409);
      }
      const event = {
        id: randomUUID(),
        ownerId: ownerId || null,
        agentId: input.agentId ? String(input.agentId).slice(0, MAX_AGENT_ID_LENGTH) : null,
        ...normalizePatch(input),
        createdAt: new Date().toISOString()
      };
      list.unshift(event);
      await persist();
      return decorate(event, now);
    },

    async update(id, input = {}, { ownerId = null, now = Date.now() } = {}) {
      const event = ownedBy(ownerId).find(item => item.id === id) || null;
      if (!event) return null;
      Object.assign(event, normalizePatch(input, { partial: true }));
      event.updatedAt = new Date().toISOString();
      await persist();
      return decorate(event, now);
    },

    async remove(id, { ownerId = null } = {}) {
      const list = all();
      const index = list.findIndex(event => event.id === id && (!ownerId || !event.ownerId || event.ownerId === ownerId));
      if (index === -1) return false;
      list.splice(index, 1);
      await persist();
      return true;
    }
  };
}
