const STORAGE_KEY = 'cochpia-life-game-v1';

export const DEFAULT_LIFE_STATE = {
  day: 1,
  timeOfDay: 'morning',
  mode: 'participate',
  location: '中央天桥',
  needs: { energy: 72, mood: 64, social: 48, health: 86 },
  relationship: 50,
  lastAction: null,
  currentEvent: null,
  recentEvents: [],
  pendingDecision: null,
  lastChanges: []
};

const TIME_OF_DAY = ['morning', 'day', 'dusk', 'night'];

// Scene locations are intentionally data-driven so art can be swapped in without
// coupling visual assets to action/state logic.
export const LIFE_SCENE_LOCATIONS = Object.freeze({ bridge: '中央天桥', cafe: '微光咖啡馆', home: '公寓' });

const ACTIONS = {
  work: { label: '去工作', place: '中央天桥', location: '中央天桥', icon: '▣', delta: { energy: -18, mood: 3, social: 5, health: -2, relationship: 1 }, event: '穿过天桥去工作，玻璃幕墙把忙碌的城市切成一格一格的光。' },
  cafe: { label: '去咖啡馆', place: '微光咖啡馆', location: '微光咖啡馆', icon: '○', delta: { energy: -5, mood: 12, social: 9, health: 0, relationship: 2 }, event: '在微光咖啡馆靠窗坐下，暖灯和城市的回声让它慢慢松下来。' },
  walk: { label: '散步', place: '中央天桥', location: '中央天桥', icon: '◇', delta: { energy: -7, mood: 9, social: 2, health: 6, relationship: 1 }, event: '沿着中央天桥走了一圈，玻璃幕墙映出了它正在成为的样子。' },
  home: { label: '回家', place: '公寓', location: '公寓', icon: '⌂', delta: { energy: 15, mood: 4, social: -5, health: 5, relationship: 1 }, event: '回到公寓，把灯调成低亮度，给自己留出恢复力气的空间。' },
  alone: { label: '独处', place: '公寓', location: '公寓', icon: '·', delta: { energy: 4, mood: 2, social: -9, health: 2, relationship: -1 }, event: '它暂时关掉外界的声音，在公寓里安静地陪自己待了一会儿。' }
};

const clamp = value => Math.max(0, Math.min(100, Math.round(value)));
const clone = value => JSON.parse(JSON.stringify(value));
const NEED_LABELS = { energy: '精力', mood: '心情', social: '社交', health: '健康', relationship: '关系' };

function getChanges(before, after) {
  return Object.entries(NEED_LABELS)
    .map(([key, label]) => ({ key, label, value: (key === 'relationship' ? after.relationship : after.needs[key]) - (key === 'relationship' ? before.relationship : before.needs[key]) }))
    .filter(change => change.value !== 0);
}

export function loadLifeState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return clone(DEFAULT_LIFE_STATE);
    return {
      ...clone(DEFAULT_LIFE_STATE),
      ...saved,
      timeOfDay: TIME_OF_DAY.includes(saved.timeOfDay) ? saved.timeOfDay : 'morning',
      needs: { ...DEFAULT_LIFE_STATE.needs, ...(saved.needs || {}) },
      recentEvents: Array.isArray(saved.recentEvents) ? saved.recentEvents : [],
      lastChanges: Array.isArray(saved.lastChanges) ? saved.lastChanges : []
    };
  } catch { return clone(DEFAULT_LIFE_STATE); }
}

export function saveLifeState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}

export function resetLifeState() {
  const state = clone(DEFAULT_LIFE_STATE);
  saveLifeState(state);
  return state;
}

function makeEvent(state, action, text, decision = null) {
  return { id: `${state.day}-${Date.now()}`, day: state.day, timeOfDay: state.timeOfDay, place: action.place, text, decision };
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

export function advanceLife(state, actionId) {
  const action = ACTIONS[actionId] || ACTIONS.home;
  const next = clone(state);
  next.day += 1;
  next.timeOfDay = TIME_OF_DAY[(next.day - 1) % TIME_OF_DAY.length];
  next.location = action.location;
  Object.entries(action.delta).forEach(([key, value]) => {
    if (key === 'relationship') next.relationship = clamp(next.relationship + value);
    else if (key in next.needs) next.needs[key] = clamp(next.needs[key] + value);
  });
  next.needs.energy = clamp(next.needs.energy - 3);
  next.needs.mood = clamp(next.needs.mood - (next.needs.social < 25 ? 4 : 0));
  const shouldAsk = next.mode === 'participate' && (next.day % 3 === 0 || next.needs.mood < 25);
  const decision = shouldAsk ? makeDecision() : null;
  next.pendingDecision = decision;
  next.lastAction = actionId;
  next.currentEvent = makeEvent(next, action, action.event, decision);
  next.recentEvents = [next.currentEvent, ...next.recentEvents].slice(0, 8);
  next.lastChanges = getChanges(state, next);
  return next;
}

export function resolveDecision(state, optionId) {
  if (!state.pendingDecision) return state;
  const option = state.pendingDecision.options.find(item => item.id === optionId);
  if (!option) return state;
  const next = clone(state);
  Object.entries(option.effect).forEach(([key, value]) => {
    if (key === 'relationship') next.relationship = clamp(next.relationship + value);
    else if (key in next.needs) next.needs[key] = clamp(next.needs[key] + value);
  });
  const event = { id: `decision-${Date.now()}`, day: next.day, timeOfDay: next.timeOfDay, place: next.location, text: option.result };
  next.currentEvent = event;
  next.recentEvents = [event, ...next.recentEvents].slice(0, 8);
  next.pendingDecision = null;
  next.lastChanges = getChanges(state, next);
  return next;
}

export function getActions() { return Object.entries(ACTIONS).map(([id, action]) => ({ id, ...action })); }
export function getTimeLabels() { return { morning: '早晨', day: '白天', dusk: '黄昏', night: '夜晚' }; }
