import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextBuilder } from './context-builder.js';
import { buildLifeCompanionContext } from './life-context.js';

test('life context uses the policy-filtered memory bundle and strips technical provenance from client context', () => {
  const context = buildLifeCompanionContext({
    contextBuilder: createContextBuilder({ defaultTokenBudget: 1200 }),
    identity: { tenantId: 'tenant-a', userId: 'user-a', relationshipId: 'relationship:cochpia' },
    personality: { version: 2, summary: '温和地陪伴。', traits: [] },
    relationship: {
      id: 'relationship:cochpia',
      agentId: 'cochpia',
      stage: 'forming',
      score: 54,
      signals: [{ sourceEventId: 'raw-secret', eventId: 'life:event', signalType: 'life.action.completed', delta: 2, evidence: '一起散步' }]
    },
    lifeState: { day: 2, timeOfDay: 'day', location: '中央天桥', needs: { energy: 60 }, currentEvent: { id: 'life:event', text: '一起散步', occurredAt: '2026-08-24T00:00:00.000Z' } },
    memoryBundle: { policyResult: 'allowed', relationshipProfile: [{ memoryId: 'memory-1', content: '共同看过日落' }], userProfile: [] }
  });
  assert.equal(context.memoryBundle.policyResult, 'allowed');
  assert.equal(context.memoryBundle.relationshipProfile[0].content, '共同看过日落');
  assert.equal(Object.hasOwn(context.memoryBundle.relationshipProfile[0], 'memoryId'), false);
  assert.equal(Object.hasOwn(context.memoryBundle.relationshipProfile[0], 'sourceRefs'), false);
  assert.equal(context.relationship.signals[0].signalType, 'life.action.completed');
  assert.equal(Object.hasOwn(context.relationship.signals[0], 'sourceEventId'), false);
  assert.equal(Object.hasOwn(context.identity, 'subjectUserId'), false);
  assert.equal(context.boundaries.memoryPurpose, 'profile_view');
});

test('life context preserves explicit filtered/not-found memory state and bounded current life state', () => {
  const context = buildLifeCompanionContext({
    contextBuilder: createContextBuilder({ defaultTokenBudget: 512 }),
    identity: { tenantId: 'tenant-a', userId: 'user-a' },
    lifeState: { day: 4, needs: { energy: 1 }, pendingDecision: { title: '决定', prompt: '是否回应？', options: [{ id: 'reply', label: '回应' }] } },
    memoryBundle: { answerability: 'not_found', policyResult: 'filtered', coreMemory: [] }
  });
  assert.equal(context.memoryBundle.answerability, 'not_found');
  assert.equal(context.memoryBundle.policyResult, 'filtered');
  assert.equal(context.currentState.day, 4);
  assert.equal(context.currentState.pendingDecision.options[0].id, 'reply');
});
