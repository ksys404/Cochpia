import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMemoryImportance, levelForScore, isRetainable, IMPORTANCE_RETAIN_THRESHOLD, IMPORTANCE_LEVELS } from './memory-importance.js';
import { createChatMemoryAdapter, inferChatMemoryType } from './chat-memory.js';

test('explicit "记住" requests land at the top of the scale', () => {
  const result = assessMemoryImportance('记住我喜欢在雨天散步');
  assert.equal(result.explicit, true);
  assert.equal(result.level, 'critical');
  assert.ok(result.score > 0.6);
  assert.ok(result.signals.some(item => item.key === 'explicit_request'));
});

test('commitments, preferences, identity, goals and time anchors each leave a trace', () => {
  const commitment = assessMemoryImportance('我答应你下个月陪你去复查');
  assert.ok(commitment.signals.some(item => item.key === 'commitment'));
  assert.equal(commitment.hasTimeAnchor, true);
  assert.ok(commitment.score >= 0.6);

  const preference = assessMemoryImportance('我不喜欢吃香菜，闻到就难受');
  assert.ok(preference.signals.some(item => item.key === 'preference'));

  const identity = assessMemoryImportance('我叫林小满，我妈妈住在杭州');
  assert.ok(identity.signals.some(item => item.key === 'identity'));

  const goal = assessMemoryImportance('我打算明年换一份不那么累的工作');
  assert.ok(goal.signals.some(item => item.key === 'goal'));
});

test('time anchors are surfaced for the calendar to consume later', () => {
  const result = assessMemoryImportance('我们的纪念日是每年 9 月 12 日');
  assert.equal(result.hasTimeAnchor, true);
  assert.equal(typeof result.timeAnchor.text, 'string');
  assert.ok(result.timeAnchor.text.length > 0);
  const signal = result.signals.find(item => item.key === 'time_anchor');
  assert.equal(signal.matched, result.timeAnchor.text, 'timeAnchor 必须与命中的信号一致');
  assert.equal(assessMemoryImportance('今天天气不错').hasTimeAnchor, false);
});

test('small talk, laughter and bare questions stay trivial', () => {
  for (const text of ['在吗', '哈哈哈', '嗯嗯', '好的', '晚安', '明天几点？', '这个怎么弄']) {
    const result = assessMemoryImportance(text);
    assert.equal(result.level, 'trivial', `「${text}」应被判为 trivial,实际 ${result.score}`);
    assert.ok(result.score <= 0.18);
  }
});

test('a short greeting does not neuter a real memory inside it', () => {
  const result = assessMemoryImportance('你好，记住我喜欢咖啡');
  assert.equal(result.explicit, true);
  assert.ok(result.score > 0.6);
});

test('emotional intensity beats a flat statement of the same length', () => {
  const flat = assessMemoryImportance('今天下午开了一个项目会议');
  const warm = assessMemoryImportance('我今天真的特别开心，好久没这么踏实了！');
  assert.equal(warm.affective, true);
  assert.ok(warm.score > flat.score, `${warm.score} 应高于 ${flat.score}`);
});

test('assessment is deterministic and explainable', () => {
  const text = '记住我每周三晚上都要去接我妹妹，这件事对我很重要';
  const first = assessMemoryImportance(text);
  const second = assessMemoryImportance(text);
  assert.deepEqual(first, second);

  // 分数必须能由 signals 复算出来,否则就是黑箱。
  const weight = first.signals.reduce((total, item) => total + item.weight, 0);
  assert.ok(weight > 0);
  for (const signal of first.signals) {
    assert.ok(signal.key && signal.label, '每条信号都要带 key 与可读 label');
    assert.ok(signal.weight > 0);
  }
  assert.equal(first.level, levelForScore(first.score));
});

test('degenerate input never throws and never claims importance', () => {
  for (const value of ['', '   ', null, undefined, 0, {}, []]) {
    const result = assessMemoryImportance(value);
    assert.equal(result.score, 0);
    assert.equal(result.level, 'trivial');
    assert.deepEqual(result.signals, []);
  }
  assert.equal(assessMemoryImportance('x'.repeat(20_000)).score <= 1, true);
});

test('retain threshold and levels agree with each other', () => {
  assert.equal(IMPORTANCE_LEVELS.length, 5);
  assert.ok(isRetainable({ score: IMPORTANCE_RETAIN_THRESHOLD }));
  assert.equal(isRetainable({ score: IMPORTANCE_RETAIN_THRESHOLD - 0.01 }), false);
  assert.equal(isRetainable(null), false);
  assert.equal(levelForScore(0), 'trivial');
  assert.equal(levelForScore(1), 'critical');
  // 单调:分数越高等级不会更低
  const order = IMPORTANCE_LEVELS;
  let previous = -1;
  for (let score = 0; score <= 1.0001; score += 0.05) {
    const index = order.indexOf(levelForScore(score));
    assert.ok(index >= previous, `等级在 score=${score.toFixed(2)} 处倒退了`);
    previous = index;
  }
});

test('a declared long-term type adds its own (small) signal', () => {
  const result = assessMemoryImportance('那家店周末人会很多', { memoryType: 'preference' });
  const declared = result.signals.find(item => item.key === 'declared_type');
  assert.ok(declared, '调用方已判定为 preference 时应留下痕迹');
  assert.ok(declared.weight < 0.1, '类型判断只是辅助,权重必须小');
});

const captureAdapter = state => {
  const held = [];
  const adapter = createChatMemoryAdapter({
    memoryModule: { hold: async (context, input) => { held.push(input); return { memory: { id: 'm-mock' } }; } },
    state,
    context: { tenantId: 't1', subjectUserId: 'u1' },
    persistState: async () => {}
  });
  return { adapter, held };
};

test('remember() stores a computed importance instead of the old constant', async () => {
  const { adapter, held } = captureAdapter({ memoryModule: {} });
  const content = '记住我每周三晚上都要去接我妹妹';
  await adapter.remember({ messageId: 'msg-1', content });

  assert.equal(held.length, 1);
  assert.equal(held[0].memoryType, inferChatMemoryType(content));
  assert.equal(held[0].importance, assessMemoryImportance(content, { memoryType: held[0].memoryType }).score);
  assert.notEqual(held[0].importance, 0.6, '不能再是写死的 0.6');
  assert.ok(held[0].importance > 0.6);
});

test('legacy memories without an importance field are scored instead of collapsing to 0', async () => {
  const state = {
    memoryModule: {},
    memories: [
      { id: 'old-1', summary: '用户喜欢在雨天散步，讨厌吵闹的地方', type: 'preference' },
      { id: 'old-2', summary: '我们的纪念日是每年 9 月 12 日', type: 'fact' }
    ]
  };
  const { adapter, held } = captureAdapter(state);
  await adapter.ensureLegacyImport();

  assert.equal(held.length, 2);
  for (const input of held) {
    assert.ok(input.importance > 0, `「${input.content}」的重要性不应是 0`);
    assert.ok(input.importance <= 1);
  }
  assert.equal(state.memoryModule.legacyImportVersion, 1);
  assert.equal(state.memories, undefined, '导入完成后应清掉旧结构');
});

test('an explicit legacy importance is preserved, not overwritten', async () => {
  const state = { memoryModule: {}, memories: [{ id: 'old-3', summary: '随便记一句', importance: 0.95 }] };
  const { adapter, held } = captureAdapter(state);
  await adapter.ensureLegacyImport();
  assert.equal(held[0].importance, 0.95);
});
