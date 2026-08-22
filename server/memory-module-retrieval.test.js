import test from 'node:test';
import assert from 'node:assert/strict';
import { bm25Search, detectConflicts, hybridSearch, reciprocalRankFusion, tokenize, vectorSearch } from './memory-module-retrieval.js';

test('tokenizer supports CJK bigrams and mixed English identifiers', () => {
  const tokens = tokenize('喜欢红茶 with OpenAI-Key');
  assert.ok(tokens.includes('红茶'));
  assert.ok(tokens.includes('红'));
  assert.ok(tokens.includes('openai_key'));
});

test('BM25 ranks exact lexical evidence above unrelated documents', () => {
  const results = bm25Search([
    { id: 'tea', text: '我喜欢红茶和乌龙茶' },
    { id: 'music', text: '最近在听爵士乐' },
    { id: 'tea-weak', text: '茶' }
  ], '红茶', { limit: 5 });
  assert.equal(results[0].id, 'tea');
  assert.equal(results.some(item => item.id === 'music'), false);
});

test('RRF fuses lexical and vector rankings without summing incomparable raw scores', () => {
  const results = reciprocalRankFusion([
    [{ id: 'a', lexical: 100 }, { id: 'b', lexical: 1 }],
    [{ id: 'b', vector: 0.99 }, { id: 'c', vector: 0.98 }]
  ]);
  assert.equal(results[0].id, 'b');
  assert.equal(results[0].score < 1, true);
});

test('conflict detection groups different values under the same canonical key', () => {
  const conflicts = detectConflicts([
    { canonicalKey: 'user:drink', content: '喜欢红茶' },
    { canonicalKey: 'user:drink', content: '喜欢咖啡' },
    { canonicalKey: 'user:color', content: '蓝色' }
  ]);
  assert.deepEqual(conflicts, [{ canonicalKey: 'user:drink', values: ['喜欢红茶', '喜欢咖啡'] }]);
});

test('vector timeout falls back to BM25 and hybrid mode uses RRF when embeddings are available', async () => {
  const documents = [
    { id: 'a', text: '红茶', embedding: [1, 0] },
    { id: 'b', text: '咖啡', embedding: [0, 1] }
  ];
  const fallback = await hybridSearch(documents, '红茶', { embed: async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); } });
  assert.equal(fallback.mode, 'bm25_embedding_timeout');
  assert.equal(fallback.items[0].id, 'a');
  const vector = await vectorSearch(documents, 'query', async () => [0, 1]);
  assert.equal(vector.mode, 'vector');
  assert.equal(vector.items[0].id, 'b');
  const hybrid = await hybridSearch(documents, '红茶', { embed: async () => [0, 1] });
  assert.equal(hybrid.mode, 'hybrid_rrf');
});
