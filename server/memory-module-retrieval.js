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
  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const id = item.id;
      documents.set(id, item);
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ ...documents.get(id), score }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
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

export async function hybridSearch(documents, query, { embed = null, limit = 50, timeoutMs = 150 } = {}) {
  const lexical = bm25Search(documents, query, { limit });
  const vector = await vectorSearch(documents, query, embed, { limit, timeoutMs });
  const fused = vector.items.length ? reciprocalRankFusion([lexical, vector.items], { limit }) : lexical;
  return { mode: vector.items.length ? 'hybrid_rrf' : `bm25_${vector.mode}`, items: fused };
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
