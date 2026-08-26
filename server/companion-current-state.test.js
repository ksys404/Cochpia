import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CURRENT_STATE_TTL_MS,
  MAX_CURRENT_STATE_TTL_MS,
  MIN_CURRENT_STATE_TTL_MS,
  getCompanionCurrentState,
  resolveCompanionCurrentStateTtl,
  restoreCompanionCurrentState,
  snapshotCompanionCurrentState,
  updateCompanionCurrentState
} from './companion-current-state.js';

const firstNow = '2026-08-25T00:00:00.000Z';
const turn = {
  topics: ['创业项目'],
  intent: 'venting',
  explicitNeed: 'listening',
  emotion: { label: '焦虑与压力', valence: -0.2, arousal: 0.4, signals: ['negative_language'] }
};

test('current state writes a bounded, sourced, TTL-bound session projection', () => {
  const session = { id: 'session-current-state-1' };
  const current = updateCompanionCurrentState(session, {
    turn,
    userMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    sourceEventId: 'raw-event-1',
    now: firstNow,
    ttlMs: 120_000
  });

  assert.equal(current.currentTopic, '创业项目');
  assert.equal(current.currentIntent, 'venting');
  assert.equal(current.currentNeed, 'listening');
  assert.equal(current.lastUserMessageId, 'user-1');
  assert.equal(current.lastAssistantMessageId, 'assistant-1');
  assert.equal(current.sourceEventId, 'raw-event-1');
  assert.equal(current.resourceRevision, 1);
  assert.equal(current.expiresAt, '2026-08-25T00:02:00.000Z');
  assert.strictEqual(session.currentState, current);
});

test('current state preserves the previous topic for an underspecified next turn and increments revision', () => {
  const session = { id: 'session-current-state-2' };
  updateCompanionCurrentState(session, { turn, now: firstNow, ttlMs: 120_000 });
  const next = updateCompanionCurrentState(session, {
    turn: { topics: [], intent: 'advice', explicitNeed: 'advice', emotion: { label: '中性' } },
    userMessageId: 'user-2',
    assistantMessageId: 'assistant-2',
    sourceEventId: 'raw-event-2',
    now: '2026-08-25T00:01:00.000Z',
    ttlMs: 120_000
  });

  assert.equal(next.currentTopic, '创业项目');
  assert.equal(next.currentIntent, 'advice');
  assert.equal(next.resourceRevision, 2);
  assert.equal(next.expiresAt, '2026-08-25T00:03:00.000Z');
});

test('expired current state is not returned and is not carried into a new turn', () => {
  const session = {
    id: 'session-current-state-3',
    currentState: {
      currentTopic: '过期话题',
      currentIntent: 'sharing',
      updatedAt: firstNow,
      expiresAt: '2026-08-25T00:01:00.000Z',
      resourceRevision: 4
    }
  };
  assert.equal(getCompanionCurrentState(session, { now: '2026-08-25T00:01:00.000Z' }), null);
  const next = updateCompanionCurrentState(session, {
    turn: { topics: [], intent: 'casual', explicitNeed: 'conversation' },
    now: '2026-08-25T00:02:00.000Z',
    ttlMs: 120_000
  });
  assert.equal(next.currentTopic, null);
  assert.equal(next.resourceRevision, 5);
});

test('legacy current state without expiry receives a sliding TTL while invalid data fails closed', () => {
  const session = {
    currentState: { currentTopic: '旧话题', updatedAt: firstNow }
  };
  const live = getCompanionCurrentState(session, { now: '2026-08-25T00:23:00.000Z', ttlMs: 1_800_000 });
  assert.equal(live.currentTopic, '旧话题');
  assert.equal(live.expiresAt, '2026-08-25T00:30:00.000Z');
  assert.equal(getCompanionCurrentState(session, { now: '2026-08-25T00:30:00.000Z', ttlMs: 1_800_000 }), null);

  const malformed = { currentState: { unsupported: () => {} } };
  assert.equal(getCompanionCurrentState(malformed), null);
});

test('current state TTL is bounded and invalid configuration falls back safely', () => {
  assert.equal(resolveCompanionCurrentStateTtl('invalid'), DEFAULT_CURRENT_STATE_TTL_MS);
  assert.equal(resolveCompanionCurrentStateTtl(1), MIN_CURRENT_STATE_TTL_MS);
  assert.equal(resolveCompanionCurrentStateTtl(Number.MAX_SAFE_INTEGER), MAX_CURRENT_STATE_TTL_MS);

  const session = {};
  const bounded = updateCompanionCurrentState(session, {
    turn: { emotion: { label: '异常输入', valence: 8, arousal: -4 } },
    now: firstNow,
    ttlMs: 120_000
  });
  assert.equal(bounded.currentEmotion.valence, 1);
  assert.equal(bounded.currentEmotion.arousal, 0);
});

test('current state snapshots restore a failed commit without retaining the new projection', () => {
  const session = {};
  updateCompanionCurrentState(session, { turn, now: firstNow, ttlMs: 120_000 });
  const snapshot = snapshotCompanionCurrentState(session);
  updateCompanionCurrentState(session, {
    turn: { topics: ['新话题'], intent: 'sharing' },
    now: '2026-08-25T00:01:00.000Z',
    ttlMs: 120_000
  });
  restoreCompanionCurrentState(session, snapshot);
  assert.equal(session.currentState.currentTopic, '创业项目');
  assert.equal(session.currentState.resourceRevision, 1);

  restoreCompanionCurrentState(session, null);
  assert.equal(session.currentState, undefined);
});
