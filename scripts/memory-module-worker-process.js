import 'dotenv/config';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';
import { createMemoryModuleServiceWorker } from '../server/memory-module-service-worker.js';
import { resolveMemoryFeatureFlags } from '../server/memory-module-flags.js';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required for a worker process');

const pool = new Pool({
  connectionString,
  ssl: resolveDbSsl(),
  max: Number(process.env.MEMORY_MODULE_POOL_MAX || 2),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10000),
  statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000),
  query_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000)
});
const repository = createMemoryModulePostgresRepository(pool);
const workerId = process.env.MEMORY_MODULE_WORKER_ID || `acceptance-worker-${process.pid}`;
const crashAfterClaim = process.env.MEMORY_MODULE_WORKER_CRASH_AFTER_CLAIM === 'true';
const worker = createMemoryModuleServiceWorker({
  repository,
  featureFlags: resolveMemoryFeatureFlags(process.env),
  workerId,
  leaseMs: Number(process.env.MEMORY_MODULE_WORKER_LEASE_MS || 30000),
  maxAttempts: Number(process.env.MEMORY_MODULE_WORKER_MAX_ATTEMPTS || 5),
  pollIntervalMs: Number(process.env.MEMORY_MODULE_WORKER_POLL_MS || 1000),
  retentionSweepIntervalMs: 60 * 60 * 1000,
  onClaim: async ({ event }) => {
    if (!crashAfterClaim) return;
    process.stderr.write(`${JSON.stringify({ event: 'acceptance_worker_crash_after_claim', workerId, eventId: event.id })}\n`);
    setImmediate(() => process.kill(process.pid, 'SIGKILL'));
    await new Promise(() => {});
  },
  onResult: result => process.stdout.write(`${JSON.stringify({ event: 'acceptance_worker_result', workerId, status: result.status, eventId: result.eventId || null })}\n`),
  onError: error => process.stderr.write(`${JSON.stringify({ event: 'acceptance_worker_error', workerId, code: error.code || 'WORKER_FAILED' })}\n`)
});

let shuttingDown = false;
const keepAlive = setInterval(() => {}, 1000);
const shutdown = async signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(keepAlive);
  await worker.stop().catch(() => {});
  await pool.end().catch(() => {});
  process.stdout.write(`${JSON.stringify({ event: 'acceptance_worker_stopped', workerId, signal })}\n`);
};

process.once('SIGTERM', () => { void shutdown('SIGTERM').finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown('SIGINT').finally(() => process.exit(0)); });
worker.start();
process.stdout.write(`${JSON.stringify({ event: 'acceptance_worker_ready', workerId, eventTypes: worker.eventTypes })}\n`);
