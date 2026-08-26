import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionChatRun, createChatRunState, isChatRunTerminal, transitionChatRun } from './chat-run-state.js';

test('chat run state machine models disconnect and terminal outcomes', () => {
  const run = createChatRunState({ runId: 'run-state-1', attempt: 2, now: '2026-08-24T00:00:00.000Z' });
  assert.equal(run.state, 'created');
  transitionChatRun(run, 'streaming', { now: '2026-08-24T00:00:01.000Z' });
  transitionChatRun(run, 'disconnected', { resumeCursor: 'run-state-1:4', now: '2026-08-24T00:00:02.000Z' });
  transitionChatRun(run, 'streaming', { now: '2026-08-24T00:00:03.000Z' });
  transitionChatRun(run, 'completed', { resumeCursor: 'run-state-1:6', now: '2026-08-24T00:00:04.000Z' });
  assert.equal(run.attempt, 2);
  assert.equal(run.lastResumeCursor, 'run-state-1:6');
  assert.equal(isChatRunTerminal(run), true);
  assert.equal(canTransitionChatRun('completed', 'streaming'), false);
});

test('chat run state machine rejects invalid terminal transitions', () => {
  const run = createChatRunState({ runId: 'run-state-2' });
  assert.throws(() => transitionChatRun(run, 'completed'), /Cannot transition chat run from created to completed/);
  transitionChatRun(run, 'streaming');
  transitionChatRun(run, 'failed', { reason: 'model_stream' });
  assert.throws(() => transitionChatRun(run, 'streaming'), error => error.code === 'CHAT_RUN_STATE_TRANSITION_INVALID');
});
