const VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LAMBDA0 = 1.5;
const DEFAULT_LAMBDA_MIN = 0.15;
const DEFAULT_LAMBDA_MAX = 8;
const DEFAULT_TAU_D = 12 * 60 * 1000;
const DEFAULT_TAU_T = 6 * HOUR_MS;
const DEFAULT_TAU_X = 25 * 60 * 1000;
const DEFAULT_SIGMA_T = 0.10;
const DEFAULT_SIGMA_X = 0.18;
const DEFAULT_M_MAX = 3;
const DEFAULT_GAMMA = 1;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));
const envNumber = (name, fallback) => Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const hashSeed = value => {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0 || 1;
};

const nextRandom = seed => {
  let value = seed >>> 0 || 1;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  value >>>= 0;
  return { seed: value || 1, value: (value || 1) / 0x100000000 };
};

const expThreshold = random => Math.max(Number.EPSILON, -Math.log(Math.max(Number.EPSILON, 1 - random)));
const decay = (value, mean, elapsed, tau) => mean + (value - mean) * 2 ** (-elapsed / tau);

const initialState = (agentId, now, seed) => {
  const random = nextRandom(seed);
  return {
    agentId,
    version: VERSION,
    activationDrive: 0.5,
    latentActivityTone: 0.5,
    stochasticDriftState: 0,
    entropySeed: random.seed,
    cycleStartedAt: new Date(now).toISOString(),
    theta: expThreshold(random.value),
    hazardAccum: 0,
    sequence: 0,
    updatedAt: new Date(now).toISOString(),
    stateVersion: VERSION,
    dispatchedWakeIds: {}
  };
};

const parseWakeDecision = value => {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(text); } catch { return null; }
};

export function createWakeEngine({
  state, saveState, innerContinuity, agents, model, createModelProvider, resolveModelSelection,
  getSession, chatMemoryForRequest, randomUUID, agentAvatar, buildRuntimeContext, collectUpcomingEvents
} = {}) {
  const enabled = process.env.WAKEUP_ENABLED === 'true';
  if (!enabled) {
    return {
      enabled: false,
      reconcile: async () => null,
      kick: async () => null,
      directWake: async () => null,
      reconcileAll: async () => null,
      stop() {}
    };
  }

  const lambdaMin = envNumber('WAKE_LAMBDA_MIN_PER_HOUR', DEFAULT_LAMBDA_MIN);
  const lambdaMax = envNumber('WAKE_LAMBDA_MAX_PER_HOUR', DEFAULT_LAMBDA_MAX);
  const tauD = envNumber('WAKE_TAU_D_MS', DEFAULT_TAU_D);
  const tauT = envNumber('WAKE_TAU_T_MS', DEFAULT_TAU_T);
  const tauX = envNumber('WAKE_TAU_X_MS', DEFAULT_TAU_X);
  const sigmaT = envNumber('WAKE_SIGMA_T', DEFAULT_SIGMA_T);
  const sigmaX = envNumber('WAKE_SIGMA_X', DEFAULT_SIGMA_X);
  const getAgent = agentId => typeof agents?.get === 'function' ? agents.get(agentId) : (agents?.list?.() || []).find(agent => agent.id === agentId);
  const privateSession = agentId => (state.sessions || []).find(session => session.kind === 'private' && session.agentId === agentId && (!getSession || getSession(session.id)));
  const getState = (agentId, now) => (state.wakeStates ||= {})[agentId] || ((state.wakeStates ||= {})[agentId] = initialState(agentId, now, hashSeed(randomUUID?.() || `${agentId}:${now}`)));
  const modulation = (agentId, now) => {
    const activation = innerContinuity?.activation?.(agentId, now) || 0;
    return clamp(1 + (DEFAULT_M_MAX - 1) * activation ** DEFAULT_GAMMA, 0.6, 3);
  };
  const calculateRate = (current, agentId, now) => clamp(
    finite(state.wakePreferences?.lambda0PerHour, envNumber('WAKE_LAMBDA0_PER_HOUR', DEFAULT_LAMBDA0)) * Math.exp(1.8 * (current.activationDrive - 0.5) + 1.6 * (current.latentActivityTone - 0.5) + 1.2 * current.stochasticDriftState) * modulation(agentId, now),
    lambdaMin, lambdaMax
  );
  const persist = async () => { if (typeof saveState === 'function') await saveState(state); };
  const recordOutcome = async (agentId, wakeId, outcome, now = Date.now()) => {
    state.wakeStates ||= {};
    const current = state.wakeStates[agentId];
    if (!current) return;
    current.events ||= [];
    current.events.push({ type: outcome.action === 'message' ? 'wake_materialized' : outcome.skipped ? 'wake_skipped' : 'wake_silent', wakeId, at: new Date(now).toISOString() });
    if (current.events.length > 50) current.events.splice(0, current.events.length - 50);
    await persist();
  };

  const reconcileState = (agentId, now) => {
    const current = getState(agentId, now);
    const previous = new Date(current.updatedAt).getTime();
    const elapsed = Number.isFinite(previous) ? Math.max(0, now - previous) : 0;
    if (!elapsed) return { current, triggered: false, lambda: calculateRate(current, agentId, now), modulation: modulation(agentId, now) };
    const rhoT = 2 ** (-elapsed / tauT);
    const rhoX = 2 ** (-elapsed / tauX);
    let random = nextRandom(current.entropySeed);
    current.activationDrive = clamp(decay(finite(current.activationDrive, 0.5), 0.5, elapsed, tauD), 0.2, 0.8);
    current.latentActivityTone = clamp(decay(finite(current.latentActivityTone, 0.5), 0.5, elapsed, tauT) + sigmaT * Math.sqrt(Math.max(0, 1 - rhoT ** 2)) * (random.value * 2 - 1), 0.25, 0.75);
    random = nextRandom(random.seed);
    current.stochasticDriftState = clamp(finite(current.stochasticDriftState, 0) * rhoX + sigmaX * Math.sqrt(Math.max(0, 1 - rhoX ** 2)) * (random.value * 2 - 1), -0.4, 0.4);
    current.entropySeed = random.seed;
    const lambda = calculateRate(current, agentId, now);
    current.hazardAccum = finite(current.hazardAccum, 0) + lambda * elapsed / HOUR_MS;
    let triggered = false;
    let wakeId = null;
    if (current.hazardAccum >= finite(current.theta, 1)) {
      triggered = true;
      current.sequence = finite(current.sequence, 0) + 1;
      wakeId = `${agentId}:${now}:${current.sequence}`;
      current.dispatchedWakeIds ||= {};
      current.dispatchedWakeIds[wakeId] = now;
      current.hazardAccum = 0;
      random = nextRandom(current.entropySeed);
      current.entropySeed = random.seed;
      current.theta = expThreshold(random.value);
      current.cycleStartedAt = new Date(now).toISOString();
    }
    current.updatedAt = new Date(now).toISOString();
    current.stateVersion = VERSION;
    return { current, triggered, wakeId, lambda, modulation: modulation(agentId, now) };
  };

  const runWake = async (agentId, wakeId, reason = 'spontaneous') => {
    const agent = getAgent(agentId);
    const session = privateSession(agentId);
    if (!agent || !session) return { action: 'silent', skipped: true };
    const providerName = agent.provider || model?.provider || process.env.MODEL_PROVIDER || 'mock';
    const modelName = agent.model || model?.model || '';
    let wakeModel = model;
    if (typeof createModelProvider === 'function') {
      const selection = typeof resolveModelSelection === 'function' ? resolveModelSelection(providerName, modelName) : { ok: true, config: { model: modelName } };
      if (!selection.ok) return { action: 'silent', skipped: true };
      wakeModel = createModelProvider(providerName, { model: selection.config.model });
    }
    if (!wakeModel || typeof wakeModel.generate !== 'function') return { action: 'silent', skipped: true };
    const messages = (state.messages?.[session.id] || []).filter(message => !message.supersededAt).slice(-20);
    const runtimeContext = typeof buildRuntimeContext === 'function'
      ? buildRuntimeContext({ messages, upcomingEvents: collectUpcomingEvents?.(agentId) || [], persona: agent.persona || '', profile: { name: agent.name }, mode: 'companion', innerState: innerContinuity?.snapshot?.(agentId, Date.now()), dynamic: { wakeup: { source: reason, wakeId } } })
      : { messages, dynamic: { wakeup: { source: reason, wakeId } } };
    const result = await wakeModel.generate({
      message: '现在是你主动醒来的机会。请作为你自己决定是否想对用户说些什么。只返回 JSON：{"action":"silent"} 或 {"action":"message","message":"..."}。沉默是合法结果，不要因为系统唤醒就强行发消息。',
      recalled: [], runtimeContext
    });
    const decision = parseWakeDecision(result);
    if (!decision || decision.action !== 'message' || !String(decision.message || '').trim()) return { action: 'silent' };
    const message = { id: randomUUID?.() || `${wakeId}:message`, role: 'assistant', content: String(decision.message).trim().slice(0, 8000), createdAt: new Date().toISOString(), source: 'wake', senderId: agent.id, senderName: agent.name, senderAvatar: agentAvatar?.(agent) || agent.name };
    state.messages[session.id] ||= [];
    state.messages[session.id].push(message);
    await persist();
    return { action: 'message', message };
  };

  const reconcile = async (agentId, now = Date.now()) => {
    if (!state.wakePreferences?.enabled) return null;
    state.wakeStates ||= {};
    if (!agentId || !getAgent(agentId)) return null;
    const result = reconcileState(agentId, Number(now));
    state.wakeStates[agentId] = result.current;
    await persist();
    if (!result.triggered || result.current.dispatchedWakeIds[result.wakeId] !== Number(now)) return result;
    const outcome = await runWake(agentId, result.wakeId);
    result.current.lastOutcome = outcome.action;
    result.current.lastWakeId = result.wakeId;
    result.current.lastWakeAt = new Date(now).toISOString();
    await recordOutcome(agentId, result.wakeId, outcome, now);
    await persist();
    return { ...result, outcome };
  };

  const kick = async (agentId, now = Date.now()) => {
    if (!state.wakePreferences?.enabled) return null;
    state.wakeStates ||= {};
    if (!agentId || !getAgent(agentId)) return null;
    const current = getState(agentId, Number(now));
    current.activationDrive = clamp(finite(current.activationDrive, 0.5) - 0.10, 0.2, 0.8);
    current.updatedAt = new Date(Number(now)).toISOString();
    await persist();
    return current;
  };

  const directWake = async (agentId, reason = 'direct') => {
    if (!state.wakePreferences?.enabled) return null;
    state.wakeStates ||= {};
    if (!agentId || !getAgent(agentId)) return null;
    const wakeId = `${agentId}:${Date.now()}:direct:${randomUUID?.() || '1'}`;
    const current = getState(agentId, Date.now());
    current.dispatchedWakeIds ||= {};
    if (current.dispatchedWakeIds[wakeId]) return null;
    current.dispatchedWakeIds[wakeId] = Date.now();
    await persist();
    const outcome = await runWake(agentId, wakeId, reason);
    current.lastOutcome = outcome.action;
    current.lastWakeId = wakeId;
    await recordOutcome(agentId, wakeId, outcome);
    await persist();
    return { wakeId, outcome };
  };

  const reconcileAll = async () => {
    if (!state.wakePreferences?.enabled) return null;
    state.wakeStates ||= {};
    const list = typeof agents?.list === 'function' ? agents.list() : [];
    for (const agent of list) {
      try { await reconcile(agent.id); } catch (error) { console.error(JSON.stringify({ event: 'wake_reconcile_failed', code: error.code || 'WAKE_RECONCILE_FAILED' })); }
    }
  };
  const rate = (agentId, now = Date.now()) => calculateRate(getState(agentId, Number(now)), agentId, Number(now));
  return { enabled: true, reconcile, reconcileAll, kick, directWake, stop() {}, rate, modulation, runWake };
}
