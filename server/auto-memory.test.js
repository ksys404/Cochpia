import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessage, shouldRemember } from './auto-memory.js';

test('shouldRemember skips short messages and keeps significant or long ones', () => {
  assert.equal(shouldRemember('你好'), false);
  assert.equal(shouldRemember('我喜欢下雨天，尤其是傍晚的时候。'), true);
  assert.equal(shouldRemember('x'.repeat(50)), true);
});

test('analyzeMessage computes clamped valence and arousal', () => {
  const positive = analyzeMessage('今天特别开心，谢谢你的陪伴，感觉幸福极了！');
  assert.ok(positive.valence > 0);
  const negative = analyzeMessage('我很难过，也很害怕，压力好大。');
  assert.ok(negative.valence < 0);
  assert.ok(positive.valence >= -1 && positive.valence <= 1);
  assert.ok(negative.arousal >= 0 && negative.arousal <= 1);
});
