import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPgvectorMigrationSql, normalizeEmbeddingDimensions, parsePgvectorVector, toPgvectorLiteral } from './memory-module-pgvector.js';

test('pgvector helpers validate dimensions and serialize vectors safely', () => {
  assert.equal(normalizeEmbeddingDimensions('1536'), 1536);
  assert.equal(toPgvectorLiteral([1, '2'], 2), '[1,2]');
  assert.deepEqual(parsePgvectorVector('[1, 2.5]'), [1, 2.5]);
  assert.deepEqual(parsePgvectorVector([1, '2']), [1, 2]);
  assert.throws(() => normalizeEmbeddingDimensions('0'), /between 1 and/);
  assert.throws(() => toPgvectorLiteral([1, Number.NaN]), /finite/);
  assert.throws(() => toPgvectorLiteral([1], 2), /dimension/);
});

test('pgvector migration creates a dimensioned vector column and HNSW cosine index', () => {
  const sql = buildPgvectorMigrationSql(1536);
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.match(sql, /embedding_vector vector\(1536\)/);
  assert.match(sql, /embedding::text::vector/);
  assert.match(sql, /USING hnsw/);
  assert.match(sql, /vector_cosine_ops/);
});
