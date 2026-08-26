import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionResponsePlan } from './companion-response-policy.js';
import { analyzeCompanionTurn } from './companion-turn-context.js';

test('response policy requires evidence for memory confirmation', () => {
  const turn = analyzeCompanionTurn({ message: '你还记得创业项目吗？' });
  const known = buildCompanionResponsePlan({ turn, memoryBundle: { answerability: 'known' } });
  const unknown = buildCompanionResponsePlan({ turn, memoryBundle: { answerability: 'not_found' } });
  assert.equal(known.mode, 'memory_confirmation');
  assert.equal(known.mentionMemory, true);
  assert.equal(unknown.memoryAnswerability, 'not_found');
  assert.match(unknown.goals.join(' '), /不要假装记得/);
});

test('response policy prioritizes empathy for negative emotional input', () => {
  const turn = analyzeCompanionTurn({ message: '我最近很累，也因为项目焦虑。' });
  const plan = buildCompanionResponsePlan({ turn });
  assert.equal(plan.mode, 'empathize_then_clarify');
  assert.equal(plan.askQuestion, true);
  assert.equal(plan.maxQuestions, 1);
  assert.match(plan.goals.join(' '), /先承接/);
});

test('response policy carries forward the previous short-term topic when the next turn is underspecified', () => {
  const turn = analyzeCompanionTurn({ message: '那你觉得我现在该怎么办？' });
  const plan = buildCompanionResponsePlan({ turn, runtimeContext: { currentState: { currentTopic: '创业项目' } } });
  assert.match(plan.goals.join(' '), /创业项目/);
});
