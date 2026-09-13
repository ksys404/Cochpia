import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reciprocalRankFusion, hybridSearch,
  effectiveImportance, recencyScore, importanceRanking, recencyRanking,
  DEFAULT_IMPORTANCE, MEMORY_RECENCY_HALF_LIFE_DAYS, SIGNAL_WEIGHTS
} from './memory-module-retrieval.js';
import { resolveMemoryFeatureFlags, MEMORY_FEATURE_DEFAULTS } from './memory-module-flags.js';
import { createMemoryModule, createMemoryModuleState } from './memory-module.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-12T12:00:00Z');
const assertionDoc = ({ id, text = '', importance, ageDays = 0, embedding = null }) => ({
  id,
  text: text || id,
  embedding,
  assertion: {
    id,
    importance,
    createdAt: new Date(NOW - ageDays * DAY).toISOString(),
    updatedAt: new Date(NOW - ageDays * DAY).toISOString()
  }
});

test('effectiveImportance reads every document shape we have', () => {
  assert.equal(effectiveImportance({ assertion: { importance: 0.73 } }), 0.73);
  // postgres 原生检索返回的行是扁平结构
  assert.equal(effectiveImportance({ importance: 0.4 }), 0.4);
  assert.equal(effectiveImportance({ currentState: { importance: 0.9 } }), 0.9);
  assert.equal(effectiveImportance({ assertion: {} }), DEFAULT_IMPORTANCE, '缺失按中性处理');
  assert.equal(effectiveImportance({ assertion: { importance: 0 } }), 0, '显式 0 不等于缺失');
  assert.equal(effectiveImportance({ assertion: { importance: 42 } }), 1, '越界要夹紧');
  assert.equal(effectiveImportance({ assertion: { importance: 'nope' } }), DEFAULT_IMPORTANCE);
  assert.equal(effectiveImportance(null), DEFAULT_IMPORTANCE);
});

test('recency uses a half-life curve, not a step function', () => {
  assert.equal(recencyScore(assertionDoc({ id: 'a', ageDays: 0 }), { now: NOW }), 1);
  assert.equal(recencyScore(assertionDoc({ id: 'a', ageDays: MEMORY_RECENCY_HALF_LIFE_DAYS }), { now: NOW }), 0.5);
  assert.equal(recencyScore(assertionDoc({ id: 'a', ageDays: MEMORY_RECENCY_HALF_LIFE_DAYS * 2 }), { now: NOW }), 0.25);
  // 未来时间不能超过 1
  assert.equal(recencyScore(assertionDoc({ id: 'a', ageDays: -5 }), { now: NOW }), 1);
  assert.equal(recencyScore({ id: 'a' }, { now: NOW }), 0, '没有时间戳就是 0');
  assert.equal(recencyScore({ id: 'a', createdAt: 'not-a-date' }, { now: NOW }), 0);
  // 单调递减
  const older = recencyScore(assertionDoc({ id: 'a', ageDays: 10 }), { now: NOW });
  const newer = recencyScore(assertionDoc({ id: 'a', ageDays: 3 }), { now: NOW });
  assert.ok(newer > older);
});

test('signal rankings order deterministically and honour limit', () => {
  const documents = [
    assertionDoc({ id: 'mid', importance: 0.5, ageDays: 5 }),
    assertionDoc({ id: 'low', importance: 0.1, ageDays: 1 }),
    assertionDoc({ id: 'high', importance: 0.9, ageDays: 40 })
  ];
  assert.deepEqual(importanceRanking(documents).map(item => item.id), ['high', 'mid', 'low']);
  assert.deepEqual(recencyRanking(documents, { now: NOW }).map(item => item.id), ['low', 'mid', 'high']);
  assert.equal(importanceRanking(documents, { limit: 2 }).length, 2);

  // 同分时按 id 稳定排序,避免同样的输入给出不同顺序
  const tied = [assertionDoc({ id: 'b', importance: 0.5 }), assertionDoc({ id: 'a', importance: 0.5 })];
  assert.deepEqual(importanceRanking(tied).map(item => item.id), ['a', 'b']);
  assert.equal(importanceRanking(documents)[0].importanceScore, 0.9);
  // 新近度榜首是 ageDays=1 那条,分数应与单点计算一致(半衰期 30 天 → 0.5^(1/30)))
  assert.equal(recencyRanking(documents, { now: NOW })[0].recencyScore, recencyScore(documents[1], { now: NOW }));
  assert.ok(recencyRanking(documents, { now: NOW })[0].recencyScore > 0.97);
});

test('reciprocalRankFusion stays backward compatible with plain arrays', () => {
  const fused = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]], { k: 60 });
  // 与旧公式逐个核对:b 在两路都出现,所以总分最高
  assert.deepEqual(fused.map(item => item.id), ['b', 'a', 'c']);
  assert.equal(fused[0].score, 1 / 62 + 1 / 61);
  assert.equal(fused[1].score, 1 / 61);
  assert.equal(fused[2].score, 1 / 62);
});

test('reciprocalRankFusion supports weighted lists', () => {
  const equal = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'b' }]]);
  assert.deepEqual(equal.map(item => item.id), ['a', 'b'], '同权重时按 id 稳定排序');
  const weighted = reciprocalRankFusion([{ items: [{ id: 'a' }], weight: 3 }, { items: [{ id: 'b' }], weight: 1 }]);
  assert.deepEqual(weighted.map(item => item.id), ['a', 'b']);
  assert.equal(weighted[0].score, 3 / 61);
  const silent = reciprocalRankFusion([{ items: [{ id: 'a' }], weight: 0 }, { items: [{ id: 'b' }], weight: 1 }]);
  assert.deepEqual(silent.map(item => item.id), ['b'], '权重 0 的一路完全不参与');
});

test('hybridSearch without signals is byte-for-byte the old behaviour', async () => {
  const documents = [
    assertionDoc({ id: 'a', text: '红茶 红茶 红茶', importance: 0.1, ageDays: 100 }),
    assertionDoc({ id: 'b', text: '红茶 绿茶', importance: 0.9, ageDays: 0 })
  ];
  const result = await hybridSearch(documents, '红茶', { embed: null });
  assert.equal(result.mode, 'bm25_disabled');
  assert.deepEqual(result.signals, []);
  // 没有向量、没有信号 → 就是纯 BM25 的顺序
  const { bm25Search } = await import('./memory-module-retrieval.js');
  assert.deepEqual(result.items.map(i => i.id), bm25Search(documents, '红茶').map(i => i.id));
});

test('importance and recency re-rank relevant candidates toward what matters', async () => {
  // a 词法上更强(重复命中)但重要性低且很旧;b 词法更弱但重要且新鲜。
  const documents = [
    assertionDoc({ id: 'a', text: '红茶 红茶 红茶 红茶', importance: 0.1, ageDays: 200 }),
    assertionDoc({ id: 'b', text: '红茶 绿茶', importance: 0.95, ageDays: 0 })
  ];
  const before = await hybridSearch(documents, '红茶', { embed: null });
  const after = await hybridSearch(documents, '红茶', { embed: null, signals: { importance: true, recency: true }, now: NOW });

  assert.deepEqual(before.items.map(i => i.id), ['a', 'b'], '不开信号时词法强者优先');
  assert.deepEqual(after.items.map(i => i.id), ['b', 'a'], '开了信号后重要且新鲜的应该上来');
  assert.deepEqual(after.signals, ['importance', 'recency']);
  assert.equal(after.mode, `${before.mode}+importance+recency`, 'mode 要显式体现信号生效,否则从返回体上看不出来');
});

test('signals never introduce a memory that lexical/vector retrieval did not find', async () => {
  const documents = [
    assertionDoc({ id: 'hit', text: '红茶 绿茶', importance: 0.1, ageDays: 100 }),
    assertionDoc({ id: 'off-topic', text: '用户喜欢爬山', importance: 1, ageDays: 0 })
  ];
  const result = await hybridSearch(documents, '红茶', { embed: null, signals: { importance: true, recency: true }, now: NOW });
  assert.deepEqual(result.items.map(i => i.id), ['hit'], '无关但极重要的记忆不能靠信号挤进结果');

  const widened = await hybridSearch(documents, '红茶', { embed: null, signals: { importance: true, recency: true, scope: 'all' }, now: NOW });
  assert.equal(widened.items.length, 2, '显式 scope=all 才允许信号扩大候选');
});

test('a vector hit also counts as relevant for the signal lists', async () => {
  const documents = [
    assertionDoc({ id: 'lexical', text: '红茶 红茶', importance: 0.1, ageDays: 200, embedding: [0, 1] }),
    assertionDoc({ id: 'vector-only', text: '完全不同的句子', importance: 0.9, ageDays: 0, embedding: [1, 0] })
  ];
  const embed = async () => [1, 0];
  const result = await hybridSearch(documents, '红茶', { embed, signals: { importance: true }, now: NOW });
  assert.equal(result.mode, 'hybrid_rrf+importance');
  assert.deepEqual(result.signals, ['importance']);
  assert.ok(result.items.some(item => item.id === 'vector-only'), '向量召回到的候选也应参与信号重排');
});

test('the importanceRanking flag is off by default and follows the env naming rule', () => {
  assert.equal(MEMORY_FEATURE_DEFAULTS.importanceRanking, false);
  assert.equal(resolveMemoryFeatureFlags({}).importanceRanking, false);
  assert.equal(resolveMemoryFeatureFlags({ MEMORY_IMPORTANCE_RANKING: 'true' }).importanceRanking, true);
  assert.equal(resolveMemoryFeatureFlags({ MEMORY_IMPORTANCE_RANKING: 'false' }).importanceRanking, false);
  assert.equal(SIGNAL_WEIGHTS.importance, 1);
  assert.equal(SIGNAL_WEIGHTS.recency < SIGNAL_WEIGHTS.importance, true, '新近度权重必须低于重要性(参考 GA 的 2:0.5)');
});

// 端到端:不只测融合函数,而是真的经 memory module 的 retrieveAsync 走一遭。
test('the flag changes real retrieval order, and nothing internal leaks into the response', async () => {
  const state = createMemoryModuleState();
  const context = { tenantId: 'tenant-a', subjectUserId: 'user-a', actorType: 'user', actorId: 'user-a' };
  const base = createMemoryModule(state);
  const lexicalStrong = await base.hold(context, { content: '红茶 红茶 红茶 红茶', key: 'lexical-strong', sensitivity: 'S0', importance: 0.1 });
  const importantFresh = await base.hold(context, { content: '红茶 绿茶', key: 'important-fresh', sensitivity: 'S0', importance: 0.95 });

  const age = (memoryId, days) => {
    const assertion = state.assertions.find(item => item.id === memoryId);
    const timestamp = new Date(Date.now() - days * DAY).toISOString();
    assertion.createdAt = timestamp;
    assertion.updatedAt = timestamp;
  };
  age(lexicalStrong.memory.memoryId, 200);
  age(importantFresh.memory.memoryId, 0);

  const off = await createMemoryModule(state).retrieveAsync(context, { query: '红茶' });
  const on = await createMemoryModule(state, async () => {}, { featureFlags: { importanceRanking: true } }).retrieveAsync(context, { query: '红茶' });

  const ids = result => result.items.map(item => item.memoryId);
  const before = ids(off);
  const after = ids(on);
  assert.equal(off.retrievalMode, 'bm25', '不开 flag 时仍走原来的纯 BM25 分支');
  assert.equal(before.length, 2);
  assert.equal(after.length, 2);
  assert.ok(
    after.indexOf(importantFresh.memory.memoryId) < before.indexOf(importantFresh.memory.memoryId),
    `重要且新鲜的记忆应该往前:${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );

  // 排序用的中间字段是内部实现,绝不能混进公开返回体
  for (const item of on.items) {
    for (const leaked of ['importanceScore', 'recencyScore', 'embedding', 'assertion']) {
      assert.equal(leaked in item, false, `返回体不应出现 ${leaked}`);
    }
  }
});
