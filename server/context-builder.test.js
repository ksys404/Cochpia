import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionContext, createContextBuilder } from './context-builder.js';

test('Context Builder returns bounded, policy-aware runtime context', () => {
  const context = buildCompanionContext({
    tokenBudget: 1_000,
    identity: { tenantId: 'tenant-context', userId: 'user-context', sessionId: 'session-1' },
    messages: Array.from({ length: 20 }, (_, index) => ({ id: String(index), role: 'user', content: '很长的上下文'.repeat(900) })),
    recalled: Array.from({ length: 24 }, (_, index) => ({ id: String(index), summary: '记忆'.repeat(500), confidence: 0.8 })),
    memoryBundle: { answerability: 'not_found', consistency: 'unknown', coreMemory: Array.from({ length: 24 }, (_, index) => ({ id: String(index), content: 'memory'.repeat(500) })) },
    boundaries: { doNotMention: ['private topic'] }
  });
  assert.equal(context.identity.userId, 'user-context');
  assert.equal(context.boundaries.doNotMention[0], 'private topic');
  assert.equal(context.budget.truncated, true);
  assert.ok(context.budget.estimatedTokens <= 1_000);
});

test('Context Builder preserves explicit not_found answerability when no memory exists', () => {
  const builder = createContextBuilder({ defaultTokenBudget: 1_000 });
  const context = builder.build({ memoryBundle: { answerability: 'not_found', consistency: 'unknown' } });
  assert.equal(context.memoryBundle.answerability, 'not_found');
  assert.equal(context.budget.truncated, false);
});

test('Context Builder carries turn state and response policy as structured data', () => {
  const context = buildCompanionContext({
    turn: { messageId: 'user-1', intent: 'venting', emotion: { label: '疲惫' } },
    currentState: { currentTopic: '创业项目', currentIntent: 'venting' },
    responsePlan: { mode: 'empathize_then_clarify', askQuestion: true, maxQuestions: 1 }
  });
  assert.equal(context.turn.intent, 'venting');
  assert.equal(context.currentState.currentTopic, '创业项目');
  assert.equal(context.responsePlan.mode, 'empathize_then_clarify');
});

test('Context Builder fails closed when the runtime envelope cannot fit the requested budget', () => {
  assert.throws(
    () => buildCompanionContext({
      tokenBudget: 256,
      messages: [{ role: 'user', content: '上下文'.repeat(4_000) }],
      summary: '摘要'.repeat(2_000),
      persona: '人格'.repeat(2_000),
      turn: { intent: 'venting' },
      responsePlan: { mode: 'empathize_then_clarify' }
    }),
    error => error.code === 'CONTEXT_TOKEN_BUDGET_TOO_SMALL' && error.status === 400
  );
});

test('Context Builder degrades malformed auxiliary records without leaking them downstream', () => {
  const relationship = { unsupported: () => {} };
  const memoryBundle = { answerability: 'known', coreMemory: [{ content: 'safe' }], unsupported: () => {} };
  const context = buildCompanionContext({ relationship, memoryBundle });
  assert.deepEqual(context.relationship, { truncated: true });
  assert.equal(context.memoryBundle.answerability, 'not_found');
});

test('Context Builder keeps circular current state and turn data JSON-safe', () => {
  const circular = {};
  circular.self = circular;
  const context = buildCompanionContext({ currentState: circular, turn: circular });
  assert.deepEqual(context.currentState, { truncated: true });
  assert.deepEqual(context.turn, { truncated: true });
});
