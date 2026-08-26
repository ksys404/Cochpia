import { randomUUID } from 'node:crypto';

export const LIFE_TIME_OF_DAY = Object.freeze(['morning', 'day', 'dusk', 'night']);
export const LIFE_SCENE_LOCATIONS = Object.freeze({ bridge: '中央天桥', cafe: '微光咖啡馆', home: '公寓' });

export const DEFAULT_LIFE_STATE = Object.freeze({
  day: 1,
  timeOfDay: 'morning',
  mode: 'participate',
  location: LIFE_SCENE_LOCATIONS.bridge,
  needs: { energy: 72, mood: 64, social: 48, health: 86 },
  lastAction: null,
  currentEvent: null,
  recentEvents: [],
  pendingDecision: null,
  lastChanges: [],
  resourceRevision: 1,
  updatedAt: null,
  commandLog: []
});

const ACTIONS = Object.freeze({
  work: { label: '去工作', place: LIFE_SCENE_LOCATIONS.bridge, location: LIFE_SCENE_LOCATIONS.bridge, icon: '▣', delta: { energy: -18, mood: 3, social: 5, health: -2, relationship: 1 }, event: '穿过天桥去工作，玻璃幕墙把忙碌的城市切成一格一格的光。' },
  cafe: { label: '去咖啡馆', place: LIFE_SCENE_LOCATIONS.cafe, location: LIFE_SCENE_LOCATIONS.cafe, icon: '○', delta: { energy: -5, mood: 12, social: 9, health: 0, relationship: 2 }, event: '在微光咖啡馆靠窗坐下，暖灯和城市的回声让它慢慢松下来。' },
  walk: { label: '散步', place: LIFE_SCENE_LOCATIONS.bridge, location: LIFE_SCENE_LOCATIONS.bridge, icon: '◇', delta: { energy: -7, mood: 9, social: 2, health: 6, relationship: 1 }, event: '沿着中央天桥走了一圈，玻璃幕墙映出了它正在成为的样子。' },
  home: { label: '回家', place: LIFE_SCENE_LOCATIONS.home, location: LIFE_SCENE_LOCATIONS.home, icon: '⌂', delta: { energy: 15, mood: 4, social: -5, health: 5, relationship: 1 }, event: '回到公寓，把灯调成低亮度，给自己留出恢复力气的空间。' },
  alone: { label: '独处', place: LIFE_SCENE_LOCATIONS.home, location: LIFE_SCENE_LOCATIONS.home, icon: '·', delta: { energy: 4, mood: 2, social: -9, health: 2, relationship: -1 }, event: '它暂时关掉外界的声音，在公寓里安静地陪自己待了一会儿。' }
});

const NEED_LABELS = { energy: '精力', mood: '心情', social: '社交', health: '健康', relationship: '关系' };
const clone = value => structuredClone(value);
const clamp = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
const isoNow = now => new Date(now()).toISOString();

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 200) throw Object.assign(new Error('idempotencyKey must be 1-200 characters'), { code: 'INVALID_LIFE_IDEMPOTENCY_KEY', status: 400 });
  return key;
}

function normalizeState(raw = {}, now = () => new Date()) {
  const next = {
    ...clone(DEFAULT_LIFE_STATE),
    ...clone(raw),
    needs: { ...clone(DEFAULT_LIFE_STATE.needs), ...(raw.needs || {}) },
    recentEvents: Array.isArray(raw.recentEvents) ? raw.recentEvents.slice(0, 20) : [],
    lastChanges: Array.isArray(raw.lastChanges) ? raw.lastChanges.slice(0, 20) : [],
    commandLog: Array.isArray(raw.commandLog) ? raw.commandLog.slice(0, 100) : []
  };
  next.day = Math.max(1, Math.floor(Number(next.day) || 1));
  next.timeOfDay = LIFE_TIME_OF_DAY.includes(next.timeOfDay) ? next.timeOfDay : 'morning';
  next.mode = next.mode === 'observe' ? 'observe' : 'participate';
  next.location = Object.values(LIFE_SCENE_LOCATIONS).includes(next.location) ? next.location : LIFE_SCENE_LOCATIONS.bridge;
  for (const key of Object.keys(next.needs)) next.needs[key] = clamp(next.needs[key]);
  delete next.relationship;
  next.resourceRevision = Math.max(1, Math.floor(Number(next.resourceRevision) || 1));
  next.updatedAt ||= isoNow(now);
  return next;
}

function changesBetween(before, after, relationshipDelta = 0) {
  const changes = Object.entries(NEED_LABELS)
    .filter(([key]) => key !== 'relationship')
    .map(([key, label]) => ({ key, label, value: after.needs[key] - before.needs[key] }))
    .filter(change => change.value !== 0);
  if (relationshipDelta) changes.push({ key: 'relationship', label: '关系', value: relationshipDelta });
  return changes;
}

function makeDecision() {
  return {
    title: '天桥边的未读消息',
    prompt: '它看见一条来自熟人的消息。现在要不要停下来回应？',
    options: [
      { id: 'reply', label: '回复对方', effect: { mood: 8, social: 10, relationship: 3 }, result: '它决定先回应这份靠近，心里亮了一点。' },
      { id: 'later', label: '晚点再说', effect: { energy: 4, social: -5, relationship: -1 }, result: '它把消息放在一边，给自己留出一点空间。' }
    ]
  };
}

function makeEvent(state, { place, text, decision = null }, eventId, occurredAt) {
  return { id: eventId, day: state.day, timeOfDay: state.timeOfDay, place, text, decision, occurredAt };
}

function transitionAction(state, actionId, eventId, occurredAt) {
  const action = ACTIONS[actionId];
  if (!action) throw Object.assign(new Error('Unknown life action'), { code: 'LIFE_ACTION_NOT_FOUND', status: 404 });
  const next = clone(state);
  next.day += 1;
  next.timeOfDay = LIFE_TIME_OF_DAY[(next.day - 1) % LIFE_TIME_OF_DAY.length];
  next.location = action.location;
  Object.entries(action.delta).forEach(([key, value]) => { if (key !== 'relationship' && key in next.needs) next.needs[key] = clamp(next.needs[key] + value); });
  next.needs.energy = clamp(next.needs.energy - 3);
  next.needs.mood = clamp(next.needs.mood - (next.needs.social < 25 ? 4 : 0));
  const decision = next.mode === 'participate' && (next.day % 3 === 0 || next.needs.mood < 25) ? makeDecision() : null;
  next.pendingDecision = decision;
  next.lastAction = actionId;
  next.currentEvent = makeEvent(next, { ...action, text: action.event }, eventId, occurredAt);
  next.recentEvents = [next.currentEvent, ...next.recentEvents].slice(0, 8);
  next.lastChanges = changesBetween(state, next, action.delta.relationship || 0);
  return next;
}

function transitionDecision(state, optionId, eventId, occurredAt) {
  if (!state.pendingDecision) throw Object.assign(new Error('No life decision is pending'), { code: 'LIFE_DECISION_NOT_PENDING', status: 409 });
  const option = state.pendingDecision.options.find(item => item.id === optionId);
  if (!option) throw Object.assign(new Error('Unknown life decision option'), { code: 'LIFE_DECISION_OPTION_NOT_FOUND', status: 404 });
  const next = clone(state);
  Object.entries(option.effect).forEach(([key, value]) => { if (key !== 'relationship' && key in next.needs) next.needs[key] = clamp(next.needs[key] + value); });
  const event = { id: eventId, day: next.day, timeOfDay: next.timeOfDay, place: next.location, text: option.result, occurredAt };
  next.currentEvent = event;
  next.recentEvents = [event, ...next.recentEvents].slice(0, 8);
  next.pendingDecision = null;
  next.lastChanges = changesBetween(state, next, option.effect.relationship || 0);
  return next;
}

function transitionReset(state, eventId, occurredAt) {
  const next = normalizeState({ ...clone(DEFAULT_LIFE_STATE), commandLog: state.commandLog }, () => new Date(occurredAt));
  next.currentEvent = { id: eventId, day: 1, timeOfDay: 'morning', place: LIFE_SCENE_LOCATIONS.home, text: '共生人生已重新开始，新的共同经历从今天展开。', occurredAt };
  next.recentEvents = [next.currentEvent];
  next.lastChanges = changesBetween(state, next);
  return next;
}

function commandEvent({ eventId, eventType, idempotencyKey, state, content, structuredData, occurredAt, actionId = null, optionId = null, sessionId = null }) {
  return {
    eventId,
    eventType,
    idempotencyKey,
    sessionId,
    stateRevision: state.resourceRevision,
    occurredAt,
    content: String(content || '').slice(0, 2_000),
    structuredData: structuredData || {},
    actionId,
    optionId,
    eventStatus: 'pending',
    rawEventId: null
  };
}

export function createLifeStateService(state, persist = async () => {}, { now = () => new Date() } = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Life state storage is required');
  state.lifeState = normalizeState(state.lifeState, now);

  const get = () => clone(state.lifeState);
  const listActions = () => Object.entries(ACTIONS).map(([id, action]) => ({ id, label: action.label, place: action.place, location: action.location, icon: action.icon }));
  const findCommand = key => state.lifeState.commandLog.find(item => item.idempotencyKey === key) || null;

  const mutate = async ({ type, idempotencyKey, expectedRevision, actionId = null, optionId = null, sessionId = null, transition, content, structuredData }) => {
    const key = normalizeIdempotencyKey(idempotencyKey);
    const normalizedSessionId = sessionId == null || sessionId === '' ? null : String(sessionId).trim().slice(0, 200) || null;
    const duplicate = findCommand(key);
    if (duplicate) return { state: get(), event: clone(duplicate), duplicate: true };
    const current = state.lifeState;
    if (expectedRevision != null && Number(expectedRevision) !== Number(current.resourceRevision)) {
      throw Object.assign(new Error('Life state revision is stale'), { code: 'LIFE_STATE_REVISION_CONFLICT', status: 409, currentResourceRevision: current.resourceRevision });
    }
    const occurredAt = isoNow(now);
    const eventId = `life:${key}`;
    const previous = clone(current);
    const next = transition(current, eventId, occurredAt);
    next.resourceRevision = current.resourceRevision + 1;
    next.updatedAt = occurredAt;
    const contentValue = typeof content === 'function' ? content(next) : content;
    const structuredDataValue = typeof structuredData === 'function' ? structuredData(next) : structuredData;
    const event = commandEvent({ eventId, eventType: type, idempotencyKey: key, state: next, content: contentValue, structuredData: structuredDataValue, occurredAt, actionId, optionId, sessionId: normalizedSessionId });
    next.commandLog = [event, ...current.commandLog].slice(0, 100);
    state.lifeState = next;
    try {
      await persist();
    } catch (error) {
      state.lifeState = previous;
      throw error;
    }
    return { state: get(), event: clone(event), duplicate: false };
  };

  const advance = (actionId, input = {}) => mutate({
    type: 'life.action.completed',
    idempotencyKey: input.idempotencyKey,
    expectedRevision: input.expectedRevision ?? input.resourceRevision,
    sessionId: input.sessionId ?? input.session_id,
    actionId,
    transition: (current, eventId, occurredAt) => transitionAction(current, actionId, eventId, occurredAt),
    content: next => next.currentEvent?.text || '',
    structuredData: next => ({ actionId, changes: next.lastChanges, relationshipDelta: ACTIONS[actionId].delta.relationship || 0, stateRevision: next.resourceRevision })
  });

  const resolveDecision = (optionId, input = {}) => mutate({
    type: 'life.decision.resolved',
    idempotencyKey: input.idempotencyKey,
    expectedRevision: input.expectedRevision ?? input.resourceRevision,
    sessionId: input.sessionId ?? input.session_id,
    optionId,
    transition: (current, eventId, occurredAt) => transitionDecision(current, optionId, eventId, occurredAt),
    content: next => next.currentEvent?.text || '',
    structuredData: next => ({ optionId, changes: next.lastChanges, relationshipDelta: next.lastChanges.find(item => item.key === 'relationship')?.value || 0, stateRevision: next.resourceRevision })
  });

  const reset = (input = {}) => mutate({
    type: 'life.state.reset',
    idempotencyKey: input.idempotencyKey,
    expectedRevision: input.expectedRevision ?? input.resourceRevision,
    sessionId: input.sessionId ?? input.session_id,
    transition: (current, eventId, occurredAt) => transitionReset(current, eventId, occurredAt),
    content: next => next.currentEvent?.text || '',
    structuredData: next => ({ reset: true, stateRevision: next.resourceRevision })
  });

  const setMode = (mode, input = {}) => {
    const normalizedMode = mode === 'observe' ? 'observe' : mode === 'participate' ? 'participate' : null;
    if (!normalizedMode) throw Object.assign(new Error('Invalid life mode'), { code: 'LIFE_MODE_INVALID', status: 400 });
    return mutate({
      type: 'life.mode.changed',
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision ?? input.resourceRevision,
      sessionId: input.sessionId ?? input.session_id,
      transition: (current, eventId, occurredAt) => {
        const next = clone(current);
        next.mode = normalizedMode;
        next.currentEvent = { id: eventId, day: next.day, timeOfDay: next.timeOfDay, place: next.location, text: `已切换为${normalizedMode === 'participate' ? '参与' : '观测'}模式。`, occurredAt };
        next.lastChanges = [];
        return next;
      },
      content: next => next.currentEvent?.text || '',
      structuredData: next => ({ mode: normalizedMode, stateRevision: next.resourceRevision })
    });
  };

  const markEventStatus = async (idempotencyKey, { status, rawEventId = null } = {}) => {
    const command = findCommand(idempotencyKey);
    if (!command) return null;
    command.eventStatus = status;
    command.rawEventId = rawEventId;
    command.eventStatusUpdatedAt = isoNow(now);
    await persist();
    return clone(command);
  };

  return { get, listActions, advance, resolveDecision, reset, setMode, markEventStatus, findCommand };
}

export { ACTIONS, changesBetween, normalizeState, transitionAction, transitionDecision };
