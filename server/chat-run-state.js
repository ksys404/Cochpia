export const CHAT_RUN_STATES = Object.freeze([
  'created',
  'streaming',
  'disconnected',
  'completed',
  'failed',
  'cancelled',
  'superseded'
]);

export const CHAT_RUN_TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled', 'superseded']);

const transitions = Object.freeze({
  created: Object.freeze(['streaming', 'failed', 'cancelled', 'superseded']),
  streaming: Object.freeze(['disconnected', 'completed', 'failed', 'cancelled', 'superseded']),
  disconnected: Object.freeze(['streaming', 'completed', 'failed', 'cancelled', 'superseded']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  superseded: Object.freeze([])
});

export class ChatRunStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChatRunStateError';
    this.code = code;
    this.status = 409;
  }
}

export function createChatRunState({ runId, attempt = 1, now = new Date() } = {}) {
  const id = String(runId || '').trim();
  if (!id) throw new ChatRunStateError('CHAT_RUN_ID_REQUIRED', 'Chat run id is required');
  return {
    state: 'created',
    stateRevision: 1,
    runId: id,
    attempt: Number.isSafeInteger(Number(attempt)) && Number(attempt) > 0 ? Number(attempt) : 1,
    stateChangedAt: new Date(now).toISOString(),
    stateReason: 'created',
    lastResumeCursor: null
  };
}

export function canTransitionChatRun(from, to) {
  if (!CHAT_RUN_STATES.includes(from) || !CHAT_RUN_STATES.includes(to)) return false;
  return from === to || transitions[from].includes(to);
}

export function transitionChatRun(run, nextState, { reason = nextState, resumeCursor = null, now = new Date() } = {}) {
  if (!run || typeof run !== 'object') throw new ChatRunStateError('CHAT_RUN_REQUIRED', 'Chat run state is required');
  if (!CHAT_RUN_STATES.includes(nextState)) throw new ChatRunStateError('CHAT_RUN_STATE_INVALID', `Invalid chat run state: ${nextState}`);
  const current = run.state || 'created';
  if (current === nextState) return run;
  if (!canTransitionChatRun(current, nextState)) throw new ChatRunStateError('CHAT_RUN_STATE_TRANSITION_INVALID', `Cannot transition chat run from ${current} to ${nextState}`);
  run.state = nextState;
  run.stateRevision = Math.max(1, Number(run.stateRevision) || 1) + 1;
  run.stateChangedAt = new Date(now).toISOString();
  run.stateReason = String(reason || nextState).slice(0, 120);
  if (resumeCursor != null) run.lastResumeCursor = String(resumeCursor).slice(0, 240);
  return run;
}

export function isChatRunTerminal(runOrState) {
  const state = typeof runOrState === 'string' ? runOrState : runOrState?.state;
  return CHAT_RUN_TERMINAL_STATES.includes(state);
}

export { transitions as CHAT_RUN_TRANSITIONS };
