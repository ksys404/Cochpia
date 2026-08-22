import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { createMemoryModule } from '../server/memory-module.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';

if (!process.env.DATABASE_URL) {
  console.log(JSON.stringify({ event: 'memory_module_postgres_smoke_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDbSsl(), max: 2, connectionTimeoutMillis: 10_000 });
const repository = createMemoryModulePostgresRepository(pool);
const tenantId = `memory-smoke-${randomUUID()}`;
const subjectUserId = `memory-smoke-${randomUUID()}`;
const otherUserId = `memory-smoke-${randomUUID()}`;
const otherTenantId = `memory-smoke-${randomUUID()}`;
const contextFor = (scopeTenantId, userId) => ({ tenantId: scopeTenantId, subjectUserId: userId, actorType: 'user', actorId: userId, callerAgentId: 'cochpia' });
const context = contextFor(tenantId, subjectUserId);
const otherUserContext = contextFor(tenantId, otherUserId);
const otherTenantContext = contextFor(otherTenantId, subjectUserId);
const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/memory-module-schema.sql');
const consumerName = `memory-smoke-${randomUUID()}`;
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

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const scopeTenantId of [tenantId, otherTenantId]) {
      for (const query of cleanupQueries) await client.query(query, [scopeTenantId]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedSubject(subjectContext, eventId, eventContent, memoryContent) {
  const memory = createMemoryModule(await repository.load(subjectContext), async () => {});
  const event = await memory.recordEvent(subjectContext, { eventId, content: eventContent });
  const created = await memory.hold(subjectContext, { content: memoryContent, sensitivity: 'S0' });
  for (const pending of memory.state.outboxEvents) pending.consumerName = consumerName;
  await repository.save(subjectContext, memory.state);
  return { event, created };
}

try {
  const applySchema = process.env.MEMORY_MODULE_SMOKE_APPLY_SCHEMA === 'true';
  if (applySchema) {
    const schema = await readFile(schemaPath, 'utf8');
    await pool.query(schema);
    await pool.query(schema);
  }

  const primarySeed = await seedSubject(context, `smoke-event-${randomUUID()}`, 'safe smoke event', 'safe smoke memory');
  const otherUserSeed = await seedSubject(otherUserContext, `smoke-event-${randomUUID()}`, 'other user event', 'other user memory');
  const otherTenantSeed = await seedSubject(otherTenantContext, `smoke-event-${randomUUID()}`, 'other tenant event', 'other tenant memory');

  const loaded = await repository.load(context);
  assert.equal(loaded.rawEvents.some(item => item.id === primarySeed.event.rawEventId), true);
  assert.equal(loaded.assertions.some(item => item.id === primarySeed.created.memory.memoryId), true);
  assert.equal(loaded.rawEvents.some(item => item.id === otherUserSeed.event.rawEventId), false);
  assert.equal(loaded.rawEvents.some(item => item.id === otherTenantSeed.event.rawEventId), false);
  assert.equal(loaded.assertions.some(item => item.id === otherUserSeed.created.memory.memoryId), false);
  assert.equal(loaded.assertions.some(item => item.id === otherTenantSeed.created.memory.memoryId), false);

  const otherUserLoaded = await repository.load(otherUserContext);
  const otherTenantLoaded = await repository.load(otherTenantContext);
  assert.equal(otherUserLoaded.assertions.some(item => item.id === otherUserSeed.created.memory.memoryId), true);
  assert.equal(otherTenantLoaded.assertions.some(item => item.id === otherTenantSeed.created.memory.memoryId), true);
  assert.equal(otherTenantLoaded.assertions.some(item => item.id === primarySeed.created.memory.memoryId), false);

  const claimed = await repository.claimOutboxEvent({ workerId: 'memory-postgres-smoke', consumerName, eventTypes: ['raw_event.created'] });
  assert.ok(claimed?.event?.id);
  const finished = await repository.finishOutboxEvent({ eventId: claimed.event.id, workerId: 'memory-postgres-smoke', status: 'completed' });
  assert.equal(finished.updated, true);
  const staleFinish = await repository.finishOutboxEvent({ eventId: claimed.event.id, workerId: 'stale-worker', status: 'completed' });
  assert.equal(staleFinish.updated, false);
  const claimedState = await repository.load(claimed.context);
  assert.equal(claimedState.outboxEvents.find(item => item.id === claimed.event.id)?.status, 'completed');

  const next = await repository.load(context);
  const nextMemory = createMemoryModule(next, async () => {});
  await nextMemory.recordEvent(context, { eventId: `fenced-event-${randomUUID()}`, content: 'lease fencing event' });
  for (const pending of nextMemory.state.outboxEvents) pending.consumerName = consumerName;
  await repository.save(context, nextMemory.state);
  const leaseStart = new Date();
  const firstWorker = await repository.claimOutboxEvent({ workerId: 'fence-worker-a', consumerName, leaseMs: 5, now: leaseStart, eventTypes: ['raw_event.created'] });
  assert.ok(firstWorker?.event?.id);
  const secondWorker = await repository.claimOutboxEvent({ workerId: 'fence-worker-b', consumerName, leaseMs: 30_000, now: new Date(leaseStart.getTime() + 10), eventTypes: ['raw_event.created'] });
  assert.equal(secondWorker?.event?.id, firstWorker.event.id);
  assert.equal((await repository.finishOutboxEvent({ eventId: firstWorker.event.id, workerId: 'fence-worker-a', status: 'completed' })).updated, false);
  assert.equal((await repository.finishOutboxEvent({ eventId: secondWorker.event.id, workerId: 'fence-worker-b', status: 'completed' })).updated, true);

  const first = await repository.load(context);
  const second = await repository.load(context);
  const firstMemory = createMemoryModule(first, async () => {});
  await firstMemory.hold(context, { content: 'first concurrent write', sensitivity: 'S0' });
  await repository.save(context, firstMemory.state);
  const secondMemory = createMemoryModule(second, async () => {});
  await secondMemory.hold(context, { content: 'stale concurrent write', sensitivity: 'S0' });
  await assert.rejects(() => repository.save(context, secondMemory.state), error => error.code === 'MEMORY_STORAGE_CONFLICT');
  console.log(JSON.stringify({ event: 'memory_module_postgres_smoke_passed', tenantId, schemaIdempotent: applySchema, subjectIsolation: true, tenantIsolation: true, workerClaimed: true, workerFencing: true, concurrencyGuard: true }));
} catch (error) {
  console.error(JSON.stringify({
    event: 'memory_module_postgres_smoke_failed',
    code: error.code || 'MEMORY_POSTGRES_SMOKE_FAILED',
    message: error.message,
    detail: error.detail,
    hint: error.hint,
    position: error.position
  }));
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (error) { console.error(JSON.stringify({ event: 'memory_module_postgres_smoke_cleanup_failed', code: error.code || 'MEMORY_POSTGRES_CLEANUP_FAILED' })); process.exitCode = 1; }
  await pool.end();
}
