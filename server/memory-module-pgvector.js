export const MAX_PGVECTOR_DIMENSIONS = 16_000;

export function normalizeEmbeddingDimensions(value) {
  const dimensions = Number(value);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_PGVECTOR_DIMENSIONS) {
    throw new TypeError(`Embedding dimensions must be an integer between 1 and ${MAX_PGVECTOR_DIMENSIONS}`);
  }
  return dimensions;
}

export function toPgvectorLiteral(value, dimensions = null) {
  if (!Array.isArray(value) || !value.length) throw new TypeError('Embedding must be a non-empty numeric vector');
  const normalized = value.map(number => Number(number));
  if (normalized.some(number => !Number.isFinite(number))) throw new TypeError('Embedding must contain only finite numbers');
  if (dimensions != null && normalized.length !== normalizeEmbeddingDimensions(dimensions)) {
    throw new TypeError('Embedding dimension does not match the configured pgvector dimension');
  }
  return `[${normalized.join(',')}]`;
}

export function parsePgvectorVector(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(number => Number(number));
    return normalized.length && normalized.every(Number.isFinite) ? normalized : null;
  }
  const text = String(value ?? '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const body = text.slice(1, -1).trim();
  if (!body) return null;
  const normalized = body.split(',').map(number => Number(number.trim()));
  return normalized.length && normalized.every(Number.isFinite) ? normalized : null;
}

export function buildPgvectorMigrationSql(dimensions) {
  const normalizedDimensions = normalizeEmbeddingDimensions(dimensions);
  return [
    'CREATE EXTENSION IF NOT EXISTS vector',
    `ALTER TABLE index_documents ADD COLUMN IF NOT EXISTS embedding_vector vector(${normalizedDimensions})`,
    'UPDATE index_documents SET embedding_vector = embedding::text::vector WHERE embedding IS NOT NULL AND embedding_vector IS NULL',
    `CREATE INDEX IF NOT EXISTS index_documents_embedding_hnsw_idx ON index_documents USING hnsw (embedding_vector vector_cosine_ops) WHERE index_status = 'active' AND embedding_vector IS NOT NULL`
  ].join(';\n') + ';\n';
}
