import 'dotenv/config';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { buildPgvectorMigrationSql, normalizeEmbeddingDimensions } from '../server/memory-module-pgvector.js';
import { createMemoryModuleNativeRetriever } from '../server/memory-module-native-retrieval.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';

if (!process.env.DATABASE_URL) {
  console.log(JSON.stringify({ event: 'memory_module_postgres_benchmark_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}
if (process.env.MEMORY_MODULE_BENCHMARK_DB_ENABLED !== 'true') {
  console.log(JSON.stringify({ event: 'memory_module_postgres_benchmark_skipped', reason: 'MEMORY_MODULE_BENCHMARK_DB_ENABLED_not_true' }));
  process.exit(0);
}

const { Pool } = pg;
const documentCount = Math.max(1, Math.min(2_000_000, Number(process.env.MEMORY_BENCHMARK_DOCUMENTS || 1_000_000)));
const requestCount = Math.max(1, Math.min(10_000, Number(process.env.MEMORY_BENCHMARK_REQUESTS || 20)));
const concurrency = Math.max(1, Math.min(requestCount, Number(process.env.MEMORY_BENCHMARK_CONCURRENCY || 20)));
const tenantCount = Math.max(2, Math.min(128, Number(process.env.MEMORY_BENCHMARK_TENANTS || 8)));
const userCount = Math.max(2, Math.min(512, Number(process.env.MEMORY_BENCHMARK_USERS || 32)));
const usePgvector = process.env.MEMORY_MODULE_BENCHMARK_PGVECTOR === 'true';
const rebuildHnswAfterSeed = usePgvector && process.env.MEMORY_MODULE_BENCHMARK_REBUILD_HNSW === 'true';
const applySchema = process.env.MEMORY_MODULE_BENCHMARK_APPLY_SCHEMA === 'true';
const dimensions = normalizeEmbeddingDimensions(process.env.MEMORY_MODULE_EMBEDDING_DIMENSIONS || 2);
const runId = randomUUID();
const tenantPrefix = `memory-benchmark-${runId}-`;
const idPrefix = `benchmark-${runId}-`;
const primaryTenantId = `${tenantPrefix}tenant-0`;
const primaryUserId = `${tenantPrefix}user-0`;
const policyVersion = 'memory-policy-v1';
const vectorValuesA = Array.from({ length: dimensions }, (_, index) => index === 0 ? 1 : 0);
const vectorValuesB = Array.from({ length: dimensions }, (_, index) => index === 1 ? 1 : 0);
const vectorA = `[${vectorValuesA.join(',')}]`;
const vectorB = `[${vectorValuesB.join(',')}]`;
const jsonVectorA = JSON.stringify(vectorValuesA);
const jsonVectorB = JSON.stringify(vectorValuesB);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSsl(),
  max: Math.max(concurrency + 2, Number(process.env.MEMORY_MODULE_BENCHMARK_POOL_MAX || concurrency + 2)),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10_000),
  statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 30_000),
  query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 30_000)
});
const repository = createMemoryModulePostgresRepository(pool, { pgvector: usePgvector });
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/memory-module-schema.sql');

async function cleanup() {
  const client = await pool.connect();
  try {
    const ready = await client.query("SELECT to_regclass('public.memory_assertions') IS NOT NULL AS ready");
    if (!ready.rows[0]?.ready) return;
    await client.query('BEGIN');
    for (const query of [
      'DELETE FROM memory_outbox_events WHERE tenant_id LIKE $1',
      'DELETE FROM current_states WHERE tenant_id LIKE $1',
      'DELETE FROM profile_snapshot_items WHERE tenant_id LIKE $1',
      'DELETE FROM profile_snapshots WHERE tenant_id LIKE $1',
      'DELETE FROM profile_projection_items WHERE tenant_id LIKE $1',
      'DELETE FROM profile_projections WHERE tenant_id LIKE $1',
      'DELETE FROM index_documents WHERE tenant_id LIKE $1',
      'DELETE FROM episode_members WHERE tenant_id LIKE $1',
      'DELETE FROM episodes WHERE tenant_id LIKE $1',
      'DELETE FROM scope_grants WHERE tenant_id LIKE $1',
      'DELETE FROM confirmation_requests WHERE tenant_id LIKE $1',
      'DELETE FROM access_confirmations WHERE tenant_id LIKE $1',
      'DELETE FROM pins WHERE tenant_id LIKE $1',
      'DELETE FROM deletion_operations WHERE tenant_id LIKE $1',
      'DELETE FROM memory_tombstones WHERE tenant_id LIKE $1',
      'DELETE FROM redaction_epochs WHERE tenant_id LIKE $1',
      'DELETE FROM memory_audit_events WHERE tenant_id LIKE $1',
      'DELETE FROM memory_idempotency_records WHERE tenant_id LIKE $1',
      'DELETE FROM assertion_version_sources WHERE tenant_id LIKE $1',
      'DELETE FROM assertion_versions WHERE tenant_id LIKE $1',
      'DELETE FROM memory_assertions WHERE tenant_id LIKE $1',
      'DELETE FROM raw_events WHERE tenant_id LIKE $1',
      'DELETE FROM memory_sessions WHERE tenant_id LIKE $1',
      'DELETE FROM memory_commit_sequences WHERE tenant_id LIKE $1'
    ]) await client.query(query, [`${tenantPrefix}%`]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seed() {
  const client = await pool.connect();
  let seedStep = 'begin';
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit = off');
    seedStep = 'assertions';
    await client.query(`
      INSERT INTO memory_assertions (
        id, tenant_id, user_id, scope_type, memory_type, assertion_type,
        canonical_key, status, subject_type, subject_id, sensitivity,
        confidence, importance, retention_policy, recall_policy,
        auto_recall_allowed, mention_policy, direct_query_policy,
        current_version_id, resource_revision, created_at, updated_at
      )
      SELECT
        $5::text || 'assertion-' || g::text,
        $1::text || 'tenant-' || (g % $2::int)::text,
        $1::text || 'user-' || (g % $3::int)::text,
        'user', 'benchmark_fact', 'observed_fact',
        'benchmark-key-' || (g % 37)::text, 'candidate', 'user',
        $1::text || 'user-' || (g % $3::int)::text, 'S0',
        0.9, 0.5, 'default_s0', 'default', true,
        'mentionable', 'allow', NULL, 1, now(), now()
      FROM generate_series(0, $4::int - 1) AS rows(g)
    `, [tenantPrefix, tenantCount, userCount, documentCount, idPrefix]);
    seedStep = 'versions';
    await client.query(`
      INSERT INTO assertion_versions (
        id, tenant_id, assertion_id, content, structured_data,
        content_type, trust_level, observed_at, version_status,
        created_by, promotion_reason, promotion_policy_version, created_at
      )
      SELECT
        $4::text || 'version-' || g::text,
        $1::text || 'tenant-' || (g % $2::int)::text,
        $4::text || 'assertion-' || g::text,
        'benchmark topic-' || (g % 37)::text || ' red tea tenant-' || (g % $2::int)::text,
        '{}'::jsonb, 'plain_text', 'user_explicit', now(), 'current',
        'user', 'benchmark_seed', 'benchmark-v1', now()
      FROM generate_series(0, $3::int - 1) AS rows(g)
    `, [tenantPrefix, tenantCount, documentCount, idPrefix]);
    seedStep = 'activate';
    await client.query(`
      UPDATE memory_assertions
         SET status='active', current_version_id=$2::text || 'version-' || replace(id, $2::text || 'assertion-', ''), updated_at=now()
       WHERE tenant_id LIKE $1::text
    `, [`${tenantPrefix}%`, idPrefix]);
    if (usePgvector) {
      seedStep = 'index_vector';
      await client.query(`
        INSERT INTO index_documents (
          id, tenant_id, source_type, source_id, source_version, user_id,
          scope_type, search_text, sensitivity, contextualizable, mentionable,
          redaction_epoch, policy_epoch, grant_version, embedding,
          embedding_vector, embedding_version, lexical_version, index_status,
          source_refs, created_at
        )
        SELECT
          $10::text || 'index-' || g::text,
          $1::text || 'tenant-' || (g % $2::int)::text,
          'assertion', $10::text || 'assertion-' || g::text, $10::text || 'version-' || g::text,
          $1::text || 'user-' || (g % $3::int)::text, 'user',
          'benchmark topic-' || (g % 37)::text || ' red tea tenant-' || (g % $2::int)::text,
          'S0', true, true, 0, $5, 0,
          CASE WHEN g % 2 = 0 THEN $6::jsonb ELSE $7::jsonb END,
          CASE WHEN g % 2 = 0 THEN $8::vector ELSE $9::vector END,
          'benchmark-v1', 'bm25-v1', 'active',
          ARRAY['benchmark-source-' || g::text], now()
        FROM generate_series(0, $4::int - 1) AS rows(g)
      `, [tenantPrefix, tenantCount, userCount, documentCount, policyVersion, jsonVectorA, jsonVectorB, vectorA, vectorB, idPrefix]);
    } else {
      seedStep = 'index_lexical';
      await client.query(`
        INSERT INTO index_documents (
          id, tenant_id, source_type, source_id, source_version, user_id,
          scope_type, search_text, sensitivity, contextualizable, mentionable,
          redaction_epoch, policy_epoch, grant_version, embedding,
          embedding_version, lexical_version, index_status, source_refs, created_at
        )
        SELECT
          $8::text || 'index-' || g::text,
          $1::text || 'tenant-' || (g % $2::int)::text,
          'assertion', $8::text || 'assertion-' || g::text, $8::text || 'version-' || g::text,
          $1::text || 'user-' || (g % $3::int)::text, 'user',
          'benchmark topic-' || (g % 37)::text || ' red tea tenant-' || (g % $2::int)::text,
          'S0', true, true, 0, $5,
          CASE WHEN g % 2 = 0 THEN $6::jsonb ELSE $7::jsonb END,
          'benchmark-v1', 'bm25-v1', 'active',
          ARRAY['benchmark-source-' || g::text], now()
        FROM generate_series(0, $4::int - 1) AS rows(g)
      `, [tenantPrefix, tenantCount, userCount, documentCount, policyVersion, jsonVectorA, jsonVectorB, idPrefix]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    error.benchmarkSeedStep = seedStep;
    throw error;
  } finally {
    client.release();
  }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] || 0;
}

async function runRequests() {
  const actor = { tenantId: primaryTenantId, subjectUserId: primaryUserId, actorType: 'user', actorId: primaryUserId, callerAgentId: 'benchmark-agent' };
  const embeddingGateway = { embed: async query => String(query).includes('vector-b') ? vectorValuesB : vectorValuesA };
  const nativeRetriever = createMemoryModuleNativeRetriever({
    repository,
    embeddingGateway,
    pgvectorEnabled: usePgvector,
    hybridRetrieval: usePgvector,
    vectorRetrieval: false,
    policyVersion
  });
  const queries = ['topic-17 red tea', 'topic-3', 'no-such-benchmark-token', 'vector-b'];
  const durations = [];
  const resultSizes = [];
  const modes = new Map();
  const failures = [];
  for (let completed = 0; completed < requestCount; completed += concurrency) {
    const batchSize = Math.min(concurrency, requestCount - completed);
    await Promise.all(Array.from({ length: batchSize }, (_, offset) => (async () => {
      const started = performance.now();
      const query = queries[(completed + offset) % queries.length];
      try {
        const result = await nativeRetriever(actor, { query, purpose: 'profile_view' });
        durations.push(performance.now() - started);
        resultSizes.push(result.items.length);
        modes.set(result.retrievalMode, (modes.get(result.retrievalMode) || 0) + 1);
      } catch (error) {
        failures.push(error.code || 'BENCHMARK_QUERY_FAILED');
      }
    })()));
  }
  return {
    p50Ms: percentile(durations, 0.50),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    minResultCount: Math.min(...resultSizes),
    maxResultCount: Math.max(...resultSizes),
    modes: Object.fromEntries(modes),
    failures
  };
}

let currentStep = 'startup';
try {
  assert.ok(documentCount >= 1);
  currentStep = 'schema';
  if (applySchema) {
    await pool.query(await readFile(schemaPath, 'utf8'));
    if (usePgvector) await pool.query(buildPgvectorMigrationSql(dimensions));
  }
  if (usePgvector) {
    const ready = await pool.query(`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS extension_ready,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='index_documents' AND column_name='embedding_vector') AS column_ready
    `);
    assert.equal(ready.rows[0]?.extension_ready, true, 'pgvector extension is not installed');
    assert.equal(ready.rows[0]?.column_ready, true, 'embedding_vector column is not present');
    if (rebuildHnswAfterSeed) {
      await pool.query('DROP INDEX IF EXISTS index_documents_embedding_hnsw_idx');
      await pool.query('DROP INDEX IF EXISTS index_documents_search_tsv_idx');
      await pool.query('DROP INDEX IF EXISTS index_documents_search_trgm_idx');
    }
  }
  currentStep = 'seed';
  await seed();
  if (rebuildHnswAfterSeed) {
    currentStep = 'hnsw';
    await pool.query("CREATE INDEX IF NOT EXISTS index_documents_embedding_hnsw_idx ON index_documents USING hnsw (embedding_vector vector_cosine_ops) WHERE index_status = 'active' AND embedding_vector IS NOT NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS index_documents_search_tsv_idx ON index_documents USING gin (to_tsvector('simple', search_text)) WHERE index_status = 'active'");
    await pool.query("CREATE INDEX IF NOT EXISTS index_documents_search_trgm_idx ON index_documents USING gin (search_text gin_trgm_ops) WHERE index_status = 'active'");
  }
  currentStep = 'analyze';
  await pool.query('ANALYZE memory_assertions; ANALYZE assertion_versions; ANALYZE index_documents');
  currentStep = 'requests';
  const metrics = await runRequests();
  if (metrics.failures.length) throw new Error(`benchmark query failures: ${metrics.failures.join(',')}`);
  console.log(JSON.stringify({
    event: 'memory_module_postgres_benchmark',
    mode: usePgvector ? 'postgres_native_hybrid' : 'postgres_native_lexical',
    documentCount,
    requestCount,
    concurrency,
    hnswRebuiltAfterSeed: rebuildHnswAfterSeed,
    tenantCount,
    userCount,
    filteredCandidateEstimate: Math.ceil(documentCount / tenantCount / userCount),
    ...metrics,
    note: 'Real PostgreSQL benchmark; run only with the explicit DB enable flag. Cleaned up by a unique tenant prefix.'
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'memory_module_postgres_benchmark_failed',
    code: error.code || 'MEMORY_POSTGRES_BENCHMARK_FAILED',
    message: error.message,
    step: currentStep,
    seedStep: error.benchmarkSeedStep,
    detail: error.detail,
    hint: error.hint,
    position: error.position
  }));
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) { console.error(JSON.stringify({ event: 'memory_module_postgres_benchmark_cleanup_failed', code: error.code || 'MEMORY_POSTGRES_BENCHMARK_CLEANUP_FAILED' })); process.exitCode = 1; }
  await pool.end();
}
