import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { createMemoryModule } from '../server/memory-module.js';
import { createMemoryModelGateway } from '../server/memory-module-model-gateway.js';
import { createMemoryModuleNativeRetriever } from '../server/memory-module-native-retrieval.js';
import { rebuildIndexDocumentsAsync } from '../server/memory-module-index.js';
import { normalizeEmbeddingDimensions, buildPgvectorMigrationSql } from '../server/memory-module-pgvector.js';
import { buildPostgresIndexCandidateQuery } from '../server/memory-module-postgres-retrieval.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';

if (!process.env.DATABASE_URL) {
  console.log(JSON.stringify({ event: 'memory_module_postgres_acceptance_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}

const { Pool } = pg;
const usePgvector = process.env.MEMORY_MODULE_ACCEPTANCE_PGVECTOR === 'true';
const applySchema = process.env.MEMORY_MODULE_ACCEPTANCE_APPLY_SCHEMA === 'true';
const configuredDimensions = normalizeEmbeddingDimensions(process.env.MEMORY_MODULE_EMBEDDING_DIMENSIONS || (usePgvector ? 2 : 2));
const vector = Array.from({ length: configuredDimensions }, (_, index) => index === 0 ? 1 : 0);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSsl(),
  max: Number(process.env.MEMORY_MODULE_ACCEPTANCE_POOL_MAX || 8),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10_000),
  statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15_000),
  query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15_000)
});

const repository = createMemoryModulePostgresRepository(pool, { pgvector: usePgvector });
const tenantId = `memory-acceptance-${randomUUID()}`;
const subjectUserId = `memory-acceptance-${randomUUID()}`;
const context = { tenantId, subjectUserId, actorType: 'user', actorId: subjectUserId, callerAgentId: 'cochpia' };
const agentA = { tenantId, subjectUserId, actorType: 'agent', actorId: 'agent-a', callerAgentId: 'agent-a' };
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/memory-module-schema.sql');

const cleanupQueries = [
  'DELETE FROM memory_outbox_events WHERE tenant_id=$1',
  'DELETE FROM current_states WHERE tenant_id=$1',
  'DELETE FROM profile_snapshot_items WHERE tenant_id=$1',
  'DELETE FROM profile_snapshots WHERE tenant_id=$1',
  'DELETE FROM profile_projection_items WHERE tenant_id=$1',
  'DELETE FROM profile_projections WHERE tenant_id=$1',
  'DELETE FROM index_documents WHERE tenant_id=$1',
  'DELETE FROM episode_members WHERE tenant_id=$1',
  'DELETE FROM episodes WHERE tenant_id=$1',
  'DELETE FROM scope_grants WHERE tenant_id=$1',
  'DELETE FROM confirmation_requests WHERE tenant_id=$1',
  'DELETE FROM access_confirmations WHERE tenant_id=$1',
  'DELETE FROM memory_mention_cooldowns WHERE tenant_id=$1',
  'DELETE FROM pins WHERE tenant_id=$1',
  'DELETE FROM deletion_operations WHERE tenant_id=$1',
  'DELETE FROM memory_tombstones WHERE tenant_id=$1',
  'DELETE FROM redaction_epochs WHERE tenant_id=$1',
  'DELETE FROM memory_audit_events WHERE tenant_id=$1',
  'DELETE FROM memory_idempotency_records WHERE tenant_id=$1',
  'DELETE FROM assertion_version_sources WHERE tenant_id=$1',
  'DELETE FROM assertion_versions WHERE tenant_id=$1',
  'DELETE FROM memory_assertions WHERE tenant_id=$1',
  'DELETE FROM raw_events WHERE tenant_id=$1',
  'DELETE FROM memory_sessions WHERE tenant_id=$1',
  'DELETE FROM memory_commit_sequences WHERE tenant_id=$1'
];

async function tableExists() {
  const result = await pool.query("SELECT to_regclass('public.memory_assertions') IS NOT NULL AS ready");
  return result.rows[0]?.ready === true;
}

async function cleanup() {
  if (!(await tableExists())) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const query of cleanupQueries) await client.query(query, [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function collectPlanNodes(value, nodes = []) {
  if (!value || typeof value !== 'object') return nodes;
  if (Array.isArray(value)) {
    for (const item of value) collectPlanNodes(item, nodes);
    return nodes;
  }
  if (value['Node Type']) nodes.push(value['Node Type']);
  for (const child of Object.values(value)) collectPlanNodes(child, nodes);
  return nodes;
}

try {
  if (applySchema) {
    await pool.query(await readFile(schemaPath, 'utf8'));
    if (usePgvector) await pool.query(buildPgvectorMigrationSql(configuredDimensions));
  }
  if (usePgvector) {
    const readiness = await pool.query(`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') AS extension_ready,
             EXISTS (
               SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='index_documents' AND column_name='embedding_vector'
             ) AS column_ready
    `);
    assert.equal(readiness.rows[0]?.extension_ready, true, 'pgvector extension is not installed');
    assert.equal(readiness.rows[0]?.column_ready, true, 'index_documents.embedding_vector is not present');
  }

  let state = await repository.load(context);
  let memory = createMemoryModule(state, async () => {});
  const primary = await memory.hold(context, { content: 'acceptance green tea preference', sensitivity: 'S0', memoryType: 'preference' });
  const relationshipA = await memory.hold(context, { content: 'agent-a private shared context', sensitivity: 'S0', memoryType: 'relationship', scopeType: 'relationship', relationshipAgentId: 'agent-a' });
  await memory.hold(context, { content: 'agent-b private shared context', sensitivity: 'S0', memoryType: 'relationship', scopeType: 'relationship', relationshipAgentId: 'agent-b' });
  await memory.grantUserScope(context, { agentId: 'agent-a', permissions: ['retrieve'], purpose: 'profile_view' });

  const embeddingGateway = createMemoryModelGateway({
    embedding: async () => vector,
    provider: 'acceptance-fixture',
    modelName: 'deterministic-vector-fixture',
    embeddingVersion: 'acceptance-fixture-v1',
    dataRetentionPolicy: 'fixture-no-external-transfer'
  });
  await rebuildIndexDocumentsAsync(memory.state, { tenantId, userId: subjectUserId, embeddingGateway });
  await repository.save(context, memory.state);

  const lexical = await repository.searchIndexDocuments(agentA, { query: 'green tea', purpose: 'profile_view', mode: 'lexical' });
  assert.equal(lexical.some(item => item.memoryId === primary.memory.memoryId), true);
  assert.equal(lexical.some(item => item.memoryId === relationshipA.memory.memoryId), false);

  const nativeRetriever = createMemoryModuleNativeRetriever({
    repository,
    embeddingGateway,
    pgvectorEnabled: usePgvector,
    hybridRetrieval: true,
    vectorRetrieval: false
  });
  const hybrid = await nativeRetriever(agentA, { query: 'green tea', purpose: 'profile_view', requireNativeRetrieval: true });
  if (usePgvector) {
    assert.equal(hybrid.retrievalMode, 'postgres_hybrid_rrf');
    assert.equal(hybrid.items.some(item => item.memoryId === primary.memory.memoryId), true);
  } else {
    assert.equal(hybrid.retrievalMode, 'postgres_lexical_pgvector_disabled');
  }

  let planNodes = [];
  let hnswObserved = false;
  if (usePgvector) {
    const vectorQuery = buildPostgresIndexCandidateQuery({
      tenantId,
      subjectUserId,
      actorType: 'agent',
      callerAgentId: 'agent-a',
      purpose: 'profile_view',
      query: 'green tea',
      queryVector: vector,
      mode: 'vector'
    });
    await pool.query('BEGIN');
    let planResult;
    try {
      // Small acceptance fixtures are too tiny for the planner to prefer HNSW;
      // force an index-capable plan so the migration is verified independently
      // from the cost choice made for a production-sized table.
      await pool.query('SET LOCAL enable_seqscan = off');
      planResult = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${vectorQuery.sql}`, vectorQuery.params);
    } finally {
      await pool.query('ROLLBACK');
    }
    planNodes = collectPlanNodes(planResult.rows[0]?.['QUERY PLAN']);
    hnswObserved = JSON.stringify(planResult.rows[0]?.['QUERY PLAN'] || '').includes('index_documents_embedding_hnsw_idx');
    if (process.env.MEMORY_MODULE_ACCEPTANCE_REQUIRE_HNSW === 'true') assert.equal(hnswObserved, true, 'vector plan did not use the HNSW index');
  }

  state = await repository.load(context);
  const persisted = state.assertions.find(item => item.id === primary.memory.memoryId);
  assert.ok(persisted);
  assert.equal(state.indexDocuments.some(item => item.sourceId === primary.memory.memoryId && (!usePgvector || Array.isArray(item.embedding))), true);
  console.log(JSON.stringify({
    event: 'memory_module_postgres_acceptance_passed',
    tenantId,
    pgvector: usePgvector,
    subjectScope: true,
    relationshipScope: true,
    lexicalNative: true,
    hybridNative: usePgvector,
    lexicalFallbackWhenPgvectorDisabled: !usePgvector,
    hnswObserved,
    planNodes
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'memory_module_postgres_acceptance_failed',
    code: error.code || 'MEMORY_POSTGRES_ACCEPTANCE_FAILED',
    message: error.message,
    detail: error.detail,
    hint: error.hint,
    position: error.position
  }));
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    console.error(JSON.stringify({ event: 'memory_module_postgres_acceptance_cleanup_failed', code: error.code || 'MEMORY_POSTGRES_ACCEPTANCE_CLEANUP_FAILED' }));
    process.exitCode = 1;
  }
  await pool.end();
}
