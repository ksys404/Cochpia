import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbSsl } from '../../server/db-ssl.js';
import { MemoryModuleError, createMemoryModule, createMemoryModuleState } from '../../server/memory-module.js';
import { createMemoryModuleRouter } from '../../server/memory-module-api.js';
import { createMemoryModulePostgresRepository } from '../../server/memory-module-postgres.js';
import { buildPgvectorMigrationSql, normalizeEmbeddingDimensions } from '../../server/memory-module-pgvector.js';
import { createMemoryModuleServiceWorker } from '../../server/memory-module-service-worker.js';
import { createMemoryModelGateway } from '../../server/memory-module-model-gateway.js';
import { createMemoryHttpEmbeddingAdapter, createMemoryHttpExtractionAdapter, resolveMemoryEmbeddingConfig, resolveMemoryExtractionConfig, validateMemoryExternalProviderConfig } from '../../server/memory-module-http-gateway.js';
import { createMemoryModuleNativeRetriever } from '../../server/memory-module-native-retrieval.js';
import { createMemoryModuleCache } from '../../server/memory-module-cache.js';
import { routeMemoryQuery } from '../../server/memory-module-query-router.js';
import { resolveMemoryFeatureFlags } from '../../server/memory-module-flags.js';
import { createObservability } from '../../server/observability.js';

const { Pool } = pg;
const app = express();
const port = Number(process.env.MEMORY_MODULE_PORT || process.env.PORT || 8791);
const serviceToken = process.env.MEMORY_MODULE_SERVICE_TOKEN || '';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for the independent Memory Module service');
if (process.env.NODE_ENV === 'production' && !serviceToken) throw new Error('MEMORY_MODULE_SERVICE_TOKEN is required in production');
if (process.env.NODE_ENV === 'production' && !['true', 'require', 'verify-full'].includes(String(process.env.DATABASE_SSL || '').toLowerCase())) throw new Error('DATABASE_SSL=true or verify-full is required in production');

const pool = new Pool({
  connectionString,
  ssl: resolveDbSsl(),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10000),
  statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
  query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
  max: Number(process.env.MEMORY_MODULE_POOL_MAX || 10)
});
let redisClient = null;
let memoryCache = null;
if (process.env.MEMORY_MODULE_REDIS_URL) {
  const candidate = createClient({ url: process.env.MEMORY_MODULE_REDIS_URL });
  candidate.on('error', () => console.error(JSON.stringify({ event: 'memory_module_cache_error', code: 'MEMORY_CACHE_BACKEND_ERROR' })));
  try {
    await candidate.connect();
    redisClient = candidate;
    memoryCache = createMemoryModuleCache({ client: candidate, ttlSeconds: Number(process.env.MEMORY_MODULE_CACHE_TTL_SECONDS || 30) });
    console.log(JSON.stringify({ event: 'memory_module_cache_enabled', backend: 'redis', ttlSeconds: memoryCache.ttlSeconds }));
  } catch {
    await candidate.disconnect().catch(() => {});
    console.error(JSON.stringify({ event: 'memory_module_cache_disabled', code: 'MEMORY_CACHE_BACKEND_UNAVAILABLE' }));
  }
}
const pgvectorEnabled = process.env.MEMORY_MODULE_PGVECTOR_ENABLED === 'true';
const repository = createMemoryModulePostgresRepository(pool, { pgvector: pgvectorEnabled, cache: memoryCache });
const memoryFeatureFlags = resolveMemoryFeatureFlags(process.env);
const nativeRetrievalEnabled = process.env.MEMORY_MODULE_NATIVE_RETRIEVAL === 'true';
const supportedOutboxSchemaVersions = String(process.env.MEMORY_MODULE_SUPPORTED_OUTBOX_SCHEMA_VERSIONS || '1')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(Number.isInteger);
const embeddingConfig = resolveMemoryEmbeddingConfig(process.env);
const extractionConfig = resolveMemoryExtractionConfig(process.env);
validateMemoryExternalProviderConfig({ nodeEnv: process.env.NODE_ENV, embeddingConfig, extractionConfig });
const extractionGateway = extractionConfig.enabled
  ? createMemoryModelGateway({
    extraction: createMemoryHttpExtractionAdapter({ url: extractionConfig.url, model: extractionConfig.model }),
    provider: process.env.MEMORY_EXTRACTION_PROVIDER || 'http-extraction',
    modelName: extractionConfig.model || 'unknown',
    promptVersion: extractionConfig.version,
    dataRetentionPolicy: extractionConfig.retentionPolicy,
    timeoutMs: extractionConfig.timeoutMs,
    retryAttempts: Number(process.env.MEMORY_EXTRACTION_RETRY_ATTEMPTS || 1)
  })
  : null;
const embeddingGateway = embeddingConfig.enabled
  ? createMemoryModelGateway({
    embedding: createMemoryHttpEmbeddingAdapter({ url: embeddingConfig.url, model: embeddingConfig.model, timeoutMs: embeddingConfig.timeoutMs }),
    provider: process.env.MEMORY_EMBEDDING_PROVIDER || 'http-embedding',
    modelName: embeddingConfig.model || 'unknown',
    embeddingVersion: embeddingConfig.version,
    dataRetentionPolicy: embeddingConfig.retentionPolicy,
    timeoutMs: embeddingConfig.timeoutMs,
    retryAttempts: Number(process.env.MEMORY_EMBEDDING_RETRY_ATTEMPTS || 1)
  })
  : null;
const observability = createObservability({ rateLimitMax: Number(process.env.MEMORY_MODULE_RATE_LIMIT_MAX || 120) });

app.use(express.json({ limit: '1mb' }));
app.use((_, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  });
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(observability.middleware);
app.use((req, res, next) => {
  if (serviceToken && req.get('authorization') !== `Bearer ${serviceToken}`) return res.status(401).json({ error: { code: 'MEMORY_MODULE_UNAUTHORIZED', message: 'Invalid service authorization' } });
  next();
});

const contextFromRequest = req => {
  const tenantId = String(req.get('x-memory-tenant-id') || '').trim();
  const subjectUserId = String(req.get('x-memory-user-id') || req.get('x-subject-user-id') || '').trim();
  const actorType = String(req.get('x-memory-actor-type') || 'agent').trim();
  const callerAgentId = String(req.get('x-memory-agent-id') || req.get('x-caller-agent-id') || '').trim();
  if (!tenantId || !subjectUserId || !callerAgentId) throw new MemoryModuleError('MEMORY_CONTEXT_REQUIRED', 'Trusted tenant, subject user, and caller agent context are required', { status: 400 });
  return {
    tenantId,
    subjectUserId,
    actorType,
    actorId: actorType === 'user' ? subjectUserId : callerAgentId,
    callerAgentId,
    sessionId: req.body?.session_id || req.query?.session_id || null
  };
};

const memoryModuleForRequest = async req => {
  const context = contextFromRequest(req);
  const requestedQueryRoute = routeMemoryQuery(req.body?.query);
  const consistencyToken = req.body?.consistency_token || req.body?.consistencyToken || null;
  const isNativeRetrieveRequest = nativeRetrievalEnabled
    && req.method === 'POST'
    && requestedQueryRoute !== 'state_current'
    && (req.path === '/v1/retrieve' || String(req.originalUrl || '').split('?')[0] === '/v1/retrieve');
  const isNativeContextBundleRequest = nativeRetrievalEnabled
    && req.method === 'POST'
    && (req.path === '/v1/context-bundles' || String(req.originalUrl || '').split('?')[0] === '/v1/context-bundles');
  const isNativeReadRequest = isNativeRetrieveRequest || isNativeContextBundleRequest;
  const consistencyCommitSeq = Number(consistencyToken?.sourceCommitSeq ?? consistencyToken?.source_commit_seq);
  const requiresCanonicalRead = isNativeRetrieveRequest && Number.isInteger(consistencyCommitSeq) && consistencyCommitSeq > 0;
  const state = isNativeRetrieveRequest && !requiresCanonicalRead
    ? { ...createMemoryModuleState(), ...(await repository.loadReadMetadata(context)) }
    : isNativeContextBundleRequest
      ? await repository.loadContextBundleState(context, { purpose: req.body?.purpose, query: req.body?.query })
      : await repository.load(context);
  const persist = isNativeReadRequest
    ? () => repository.saveAccessConfirmations(context, state.accessConfirmations)
    : () => repository.save(context, state);
  const nativeRetriever = isNativeRetrieveRequest
    ? createMemoryModuleNativeRetriever({
      repository,
      embeddingGateway,
      pgvectorEnabled,
      hybridRetrieval: memoryFeatureFlags.hybridRetrieval,
      vectorRetrieval: memoryFeatureFlags.vectorRetrieval,
      policyVersion: state.policyVersion || 'memory-policy-v1'
    })
    : null;
  return createMemoryModule(state, persist, {
    featureFlags: memoryFeatureFlags,
    embeddingGateway,
    nativeRetriever,
    mentionCooldownMs: Number(process.env.MEMORY_MODULE_MENTION_COOLDOWN_MS || 6 * 60 * 60 * 1000)
  });
};

app.get('/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'cochpia-memory-module', storage: 'postgres' });
  } catch {
    res.status(503).json({ ok: false, service: 'cochpia-memory-module', storage: 'postgres' });
  }
});
app.get('/metrics', async (_, res) => {
  try {
    const operational = typeof repository.getOperationalMetrics === 'function' ? await repository.getOperationalMetrics() : null;
    res.json({ service: 'cochpia-memory-module', ...observability.getMetrics(), operational });
  } catch {
    res.status(503).json({ service: 'cochpia-memory-module', ...observability.getMetrics(), operational: { status: 'unavailable' } });
  }
});

app.use('/v1', createMemoryModuleRouter({ memoryModuleForRequest, contextFromRequest }));

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/memory-module-schema.sql');
if (process.env.MEMORY_MODULE_AUTO_MIGRATE === 'true') {
  await pool.query(await readFile(schemaPath, 'utf8'));
  if (pgvectorEnabled) await pool.query(buildPgvectorMigrationSql(normalizeEmbeddingDimensions(process.env.MEMORY_MODULE_EMBEDDING_DIMENSIONS)));
}
if (pgvectorEnabled) {
  const vectorReady = await pool.query(`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS extension_ready,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'index_documents' AND column_name = 'embedding_vector'
           ) AS column_ready
  `);
  const row = vectorReady.rows[0] || {};
  if (!row.extension_ready || !row.column_ready) throw new Error('MEMORY_MODULE_PGVECTOR_ENABLED requires the pgvector migration to run first');
}

const memoryWorker = process.env.MEMORY_MODULE_WORKER_ENABLED === 'false'
  ? null
  : createMemoryModuleServiceWorker({
    repository,
    featureFlags: memoryFeatureFlags,
    modelGateway: extractionGateway,
    embeddingGateway,
    workerId: process.env.MEMORY_MODULE_WORKER_ID || undefined,
    leaseMs: Number(process.env.MEMORY_MODULE_WORKER_LEASE_MS || 30_000),
    maxAttempts: Number(process.env.MEMORY_MODULE_WORKER_MAX_ATTEMPTS || 5),
    pollIntervalMs: Number(process.env.MEMORY_MODULE_WORKER_POLL_MS || 1_000),
    retentionSweepIntervalMs: Number(process.env.MEMORY_MODULE_RETENTION_SWEEP_MS || 60_000),
    retentionSweepBatchSize: Number(process.env.MEMORY_MODULE_RETENTION_SWEEP_BATCH || 10),
    supportedSchemaVersions: supportedOutboxSchemaVersions,
    onResult: result => console.log(JSON.stringify({ event: 'memory_module_worker_result', workerId: result.workerId || undefined, eventId: result.eventId, status: result.status, result: result.result || null })),
    onError: error => console.error(JSON.stringify({ event: 'memory_module_worker_error', code: error.code || 'MEMORY_WORKER_FAILED' }))
  });
memoryWorker?.start();

const server = app.listen(port, () => console.log(JSON.stringify({ event: 'memory_module_listening', port, storage: 'postgres' })));
let shuttingDown = false;
const shutdown = async signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  await memoryWorker?.stop();
  server.close();
  await pool.end();
  if (redisClient) await redisClient.quit().catch(() => {});
  console.log(JSON.stringify({ event: 'memory_module_stopped', signal }));
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
