import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCompanionTurn } from './companion-turn-context.js';

test('turn context identifies memory confirmation and keeps topic hints', () => {
  const turn = analyzeCompanionTurn({
    messageId: 'm-1',
    message: '你还记得我刚才说的创业项目和产品设计吗？',
    messages: [{ role: 'user', content: '我在准备创业项目' }]
  });
  assert.equal(turn.messageId, 'm-1');
  assert.equal(turn.intent, 'memory_check');
  assert.equal(turn.asksAboutMemory, true);
  assert.ok(turn.topics.includes('创业项目'));
});

test('turn context does not mistake a memory save request for a memory question', () => {
  assert.equal(analyzeCompanionTurn({ message: '请记住：我周末喜欢散步。' }).intent, 'sharing');
  assert.equal(analyzeCompanionTurn({ message: '我记得上周下过雨。' }).intent, 'casual');
});

test('turn context identifies emotional venting without requiring a role prompt', () => {
  const turn = analyzeCompanionTurn({ message: '今天真的很累，创业项目一直没有进展，我有点焦虑。' });
  assert.equal(turn.intent, 'venting');
  assert.equal(turn.explicitNeed, 'listening');
  assert.equal(turn.emotion.label, '焦虑与压力');
  assert.ok(turn.emotion.valence < 0);
});

test('turn context separates advice requests from ordinary sharing', () => {
  assert.equal(analyzeCompanionTurn({ message: '我该怎么办？要不要先暂停项目？' }).intent, 'advice');
  assert.equal(analyzeCompanionTurn({ message: '我终于把产品设计课程学完了！' }).intent, 'sharing');
  assert.equal(analyzeCompanionTurn({ message: '你好' }).intent, 'greeting');
});
