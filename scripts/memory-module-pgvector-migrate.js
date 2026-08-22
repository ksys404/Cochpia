import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { buildPgvectorMigrationSql, normalizeEmbeddingDimensions } from '../server/memory-module-pgvector.js';

const dimensions = normalizeEmbeddingDimensions(process.env.MEMORY_MODULE_EMBEDDING_DIMENSIONS);
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ event: 'memory_module_pgvector_migration_dry_run', dimensions, sql: buildPgvectorMigrationSql(dimensions) }));
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required before running the pgvector migration');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDbSsl(), connectionTimeoutMillis: 10_000, max: 2 });
const root = path.dirname(fileURLToPath(import.meta.url));

try {
  await pool.query(await readFile(path.join(root, '../server/memory-module-schema.sql'), 'utf8'));
  await pool.query(buildPgvectorMigrationSql(dimensions));
  const verification = await pool.query(`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS extension_ready,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'index_documents' AND column_name = 'embedding_vector'
           ) AS column_ready,
           EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'index_documents_embedding_hnsw_idx') AS index_ready
  `);
  const result = verification.rows[0] || {};
  if (!result.extension_ready || !result.column_ready || !result.index_ready) throw new Error('pgvector migration verification failed');
  console.log(JSON.stringify({ event: 'memory_module_pgvector_migration_passed', dimensions, extensionReady: true, columnReady: true, indexReady: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'memory_module_pgvector_migration_failed', code: error.code || 'MEMORY_PGVECTOR_MIGRATION_FAILED' }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
