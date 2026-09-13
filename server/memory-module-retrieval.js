const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function tokenize(value) {
  const normalized = String(value || '').toLowerCase().replace(/[-/]/g, '_');
  const tokens = normalized.match(/[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || [];
  const result = [];
  for (const token of tokens) {
    if (cjkPattern.test(token) && token.length > 1) {
      const chars = [...token];
      result.push(...chars);
      for (let index = 0; index < chars.length - 1; index += 1) result.push(chars.slice(index, index + 2).join(''));
    } else result.push(token);
  }
  return result;
}

export function bm25Search(documents, query, { k1 = 1.2, b = 0.75, limit = 50 } = {}) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !documents.length) return [];
  const prepared = documents.map(document => ({ ...document, tokens: tokenize(document.text) }));
  const documentFrequency = new Map();
  for (const document of prepared) for (const token of new Set(document.tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  const averageLength = prepared.reduce((sum, document) => sum + document.tokens.length, 0) / prepared.length || 1;
  const queryFrequency = new Map();
  for (const token of queryTokens) queryFrequency.set(token, (queryFrequency.get(token) || 0) + 1);
  return prepared.map(document => {
    const frequencies = new Map();
    for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
    let score = 0;
    for (const [token, queryCount] of queryFrequency) {
      const frequency = frequencies.get(token) || 0;
      if (!frequency) continue;
      const df = documentFrequency.get(token) || 0;
      const idf = Math.log(1 + (prepared.length - df + 0.5) / (df + 0.5));
      const normalizedLength = 1 - b + b * document.tokens.length / averageLength;
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * normalizedLength)) * (1 + Math.log1p(queryCount));
    }
    return { ...document, score };
  }).filter(document => document.score > 0).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

export function reciprocalRankFusion(rankedLists, { k = 60, limit = 50 } = {}) {
  const scores = new Map();
  const documents = new Map();
  for (const entry of rankedLists) {
    // 兼容旧调用:纯数组 = 权重 1;也可以传 { items, weight } 做加权 RRF。
    const list = Array.isArray(entry) ? entry : (entry?.items || []);
    const weight = Array.isArray(entry) ? 1 : (Number.isFinite(Number(entry?.weight)) ? Number(entry.weight) : 1);
    // 权重 <= 0 等于「这一路关掉了」:连占位都不应该留,否则会以 0 分混进结果。
    if (weight <= 0 || !list.length) continue;
    list.forEach((item, index) => {
      const id = item.id;
      documents.set(id, item);
      scores.set(id, (scores.get(id) || 0) + weight / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ ...documents.get(id), score }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
}

// ===================== 重要性 / 新近度信号 =====================
//
// 参考(已核对源码,非二手转述):
// · Stanford Generative Agents 的 retrieve.py:检索是三路加权 ——
//     master = recency_w*recency*gw[0] + relevance_w*relevance*gw[1] + importance_w*importance*gw[2]
//   代码里 gw = [0.5, 3, 2],即 significance 维度里 importance(2) > recency(0.5);
//   每个分量先在该次候选集内归一化到 [0,1] 再线性相加。
// · MemoryBank:按 Ebbinghaus 遗忘曲线,依 significance 与时间流逝选择强化/遗忘。
// · Kli 主体内在连续性:x(t)=q+(x0−q)·2^(−t/T50) —— 用「半衰期」而非逐步索引衰减。
//
// 我们**不照抄线性加权**:它需要候选集内归一化,同一记忆在不同查询下分数不可比,
// 且我们已有的架构就是「多路排名 + RRF 融合」。所以把重要性与新近度做成额外两路排名接进 RRF,
// 权重比例参考 GA 的 importance:recency = 2:0.5。
//
// 重要边界:**信号只影响排序,不影响可见性**。衰减绝不能变成「看不见」——
// 我们的口径是隐藏但可审计(tombstone + redactionEpoch),忘不忘由用户决定。
export const DEFAULT_IMPORTANCE = 0.5;
/** 新近半衰期(天):30 天前的记忆在「新近度」这一路上只值一半。 */
export const MEMORY_RECENCY_HALF_LIFE_DAYS = Math.max(1, Number(process.env.MEMORY_RECENCY_HALF_LIFE_DAYS || 30));
/** 各路在 RRF 里的权重。lexical/vector 保持 1,与既有行为一致。 */
export const SIGNAL_WEIGHTS = Object.freeze({ lexical: 1, vector: 1, importance: 1, recency: 0.25 });

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp01 = value => Math.max(0, Math.min(1, value));

const documentTimestamp = document => {
  const raw = document?.assertion?.updatedAt ?? document?.assertion?.createdAt
    ?? document?.currentState?.updatedAt ?? document?.currentState?.createdAt
    ?? document?.updatedAt ?? document?.createdAt ?? null;
  const time = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : null;
};

/**
 * 取一条候选的有效重要性。
 * 缺失 → 中性 0.5;显式 0 → 保持 0(历史上「未设」与「毫无价值」都写成 0 无法区分,
 * 跑一次 scripts/backfill-memory-importance.js 就能把它们变成真实分数)。
 * 将来接入「被召回热度」时,这里就是唯一的合成点。
 */
export function effectiveImportance(document) {
  const raw = document?.assertion?.importance ?? document?.currentState?.importance ?? document?.importance;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_IMPORTANCE;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp01(value) : DEFAULT_IMPORTANCE;
}

/** 新近度:半衰期形式,0 天 = 1,一个半衰期 = 0.5,两个 = 0.25。 */
export function recencyScore(document, { now = Date.now(), halfLifeDays = MEMORY_RECENCY_HALF_LIFE_DAYS } = {}) {
  const timestamp = documentTimestamp(document);
  if (timestamp === null) return 0;
  const ageDays = Math.max(0, (Number(now) - timestamp) / DAY_MS);
  return 0.5 ** (ageDays / halfLifeDays);
}

export function importanceRanking(documents, { limit = 50 } = {}) {
  return [...(documents || [])]
    .map(document => ({ document, score: effectiveImportance(document) }))
    .sort((left, right) => right.score - left.score || String(left.document.id).localeCompare(String(right.document.id)))
    .slice(0, limit)
    .map(item => ({ ...item.document, importanceScore: item.score }));
}

export function recencyRanking(documents, { limit = 50, now = Date.now(), halfLifeDays = MEMORY_RECENCY_HALF_LIFE_DAYS } = {}) {
  return [...(documents || [])]
    .map(document => ({ document, score: recencyScore(document, { now, halfLifeDays }) }))
    .sort((left, right) => right.score - left.score || String(left.document.id).localeCompare(String(right.document.id)))
    .slice(0, limit)
    .map(item => ({ ...item.document, recencyScore: item.score }));
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export async function vectorSearch(documents, query, embed, { limit = 50, timeoutMs = 150 } = {}) {
  if (typeof embed !== 'function' || !documents.length) return { mode: 'disabled', items: [] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const queryVector = await embed(query, { signal: controller.signal, purpose: 'memory_retrieval' });
    const items = [];
    for (const document of documents) {
      if (!Array.isArray(document.embedding)) continue;
      items.push({ ...document, score: cosineSimilarity(queryVector, document.embedding) });
    }
    return { mode: 'vector', items: items.filter(item => item.score > 0).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit) };
  } catch (error) {
    return { mode: error?.name === 'AbortError' ? 'embedding_timeout' : 'embedding_error', items: [], errorCode: error?.code || 'EMBEDDING_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function hybridSearch(documents, query, { embed = null, limit = 50, timeoutMs = 150, signals = null, now = Date.now() } = {}) {
  const lexical = bm25Search(documents, query, { limit });
  const vector = await vectorSearch(documents, query, embed, { limit, timeoutMs });
  const lists = [{ items: lexical, weight: SIGNAL_WEIGHTS.lexical }];
  if (vector.items.length) lists.push({ items: vector.items, weight: SIGNAL_WEIGHTS.vector });
  const signalsUsed = [];
  if (signals?.importance || signals?.recency) {
    // 默认只对「已经被词法/向量召回命中」的候选做重排。信号不负责无中生有地捞回记忆:
    // 否则一条与当前话题无关但「很重要」的记忆会挤掉真正相关的答案。
    // 「无关时也主动想起」是另一件事,交给 proactiveMention,不混进检索。
    const relevantIds = new Set([...lexical, ...vector.items].map(item => item.id));
    const scope = signals?.scope === 'all' ? documents : documents.filter(document => relevantIds.has(document.id));
    if (signals?.importance) {
      lists.push({ items: importanceRanking(scope, { limit }), weight: SIGNAL_WEIGHTS.importance });
      signalsUsed.push('importance');
    }
    if (signals?.recency) {
      lists.push({ items: recencyRanking(scope, { limit, now }), weight: SIGNAL_WEIGHTS.recency });
      signalsUsed.push('recency');
    }
  }
  // 只有一路时不融合,保持与历史完全一致的行为。
  const fused = lists.length > 1 ? reciprocalRankFusion(lists, { limit }) : lexical;
  // 用了信号就在 mode 里显式标出来:否则从返回体上看不出 flag 到底生没生效。
  const baseMode = vector.items.length ? 'hybrid_rrf' : `bm25_${vector.mode}`;
  return { mode: signalsUsed.length ? `${baseMode}+${signalsUsed.join('+')}` : baseMode, items: fused, signals: signalsUsed };
}

export function detectConflicts(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.canonicalKey) continue;
    const values = groups.get(item.canonicalKey) || new Map();
    const value = item.content || JSON.stringify(item.structuredData || {});
    values.set(value, (values.get(value) || 0) + 1);
    groups.set(item.canonicalKey, values);
  }
  return [...groups.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([canonicalKey, values]) => ({ canonicalKey, values: [...values.keys()] }));
}
