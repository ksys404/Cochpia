import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { createMemoryModule } from '../server/memory-module.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';
import { applyMemoryModuleSchema } from '../server/memory-module-pg-migration.js';

if (!process.env.DATABASE_URL) {
  console.log(JSON.stringify({ event: 'memory_module_multiprocess_acceptance_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}

const { Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSsl(),
  max: 6,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  query_timeout: 15_000
});
const repository = createMemoryModulePostgresRepository(pool);
const tenantId = `multiprocess-${randomUUID()}`;
const subjectUserId = `multiprocess-${randomUUID()}`;
const context = { tenantId, subjectUserId, actorType: 'user', actorId: subjectUserId, callerAgentId: 'cochpia' };
const schemaPath = path.join(root, 'server/memory-module-schema.sql');
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
  'DELETE FROM memory_export_operations WHERE tenant_id=$1',
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const childProcesses = [];

function waitForLine(child, pattern, label, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onError);
      child.off('exit', onExit);
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.includes(pattern)) continue;
        try { finish(null, JSON.parse(line)); } catch { finish(null, { line }); }
        return;
      }
    };
    const onError = chunk => { buffer += String(chunk); };
    const onExit = code => finish(new Error(`${label} exited before readiness (${code})`));
    const timer = setTimeout(() => finish(new Error(`${label} readiness timeout`)), timeoutMs);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onError);
    child.once('exit', onExit);
  });
}

function waitForExit(child, label, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function cleanup() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const query of cleanupQueries) await client.query(query, [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  if (process.env.MEMORY_MODULE_ACCEPTANCE_APPLY_SCHEMA === 'true') {
    await applyMemoryModuleSchema(pool, { schema: await readFile(schemaPath, 'utf8') });
  }

  const memory = createMemoryModule(await repository.load(context), async () => {});
  const event = await memory.recordEvent(context, {
    eventId: `multiprocess-event-${randomUUID()}`,
    content: 'multi-process worker acceptance probe'
  });
  await repository.save(context, memory.state);
  const outboxId = memory.state.outboxEvents.find(item => item.aggregateId === event.rawEventId)?.id;
  assert.ok(outboxId, 'seed event must create an outbox row');

  const workerEnv = {
    ...process.env,
    NODE_ENV: 'test',
    MEMORY_AUTO_PROFILE_UPDATE: 'true',
    MEMORY_AUTO_EXTRACT: 'false',
    MEMORY_EPISODE_GROUPING: 'false',
    MEMORY_HYBRID_RETRIEVAL: 'false',
    MEMORY_VECTOR_RETRIEVAL: 'false',
    MEMORY_PROACTIVE_MENTION: 'false',
    MEMORY_MODULE_WORKER_POLL_MS: '50',
    MEMORY_MODULE_WORKER_LEASE_MS: '500',
    MEMORY_MODULE_WORKER_MAX_ATTEMPTS: '3',
    MEMORY_MODULE_RETENTION_SWEEP_MS: String(60 * 60 * 1000)
  };
  for (const workerId of ['multiprocess-worker-a', 'multiprocess-worker-b']) {
    const child = spawn(process.execPath, ['scripts/memory-module-worker-process.js'], {
      cwd: root,
      env: { ...workerEnv, MEMORY_MODULE_WORKER_ID: workerId },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    childProcesses.push(child);
    await waitForLine(child, 'acceptance_worker_ready', workerId);
  }

  const deadline = Date.now() + 20_000;
  let loaded;
  let outbox;
  while (Date.now() < deadline) {
    loaded = await repository.load(context);
    outbox = loaded.outboxEvents.find(item => item.id === outboxId);
    if (outbox?.status === 'completed') break;
    await sleep(100);
  }
  assert.equal(outbox?.status, 'completed', `outbox event was not completed: ${outbox?.status || 'missing'}`);
  assert.equal(Number(outbox.attempts), 1, 'two workers must not process the same event twice');
  assert.equal(outbox.leaseOwner, null, 'completed event must release its lease');
  assert.equal(outbox.leaseUntil, null, 'completed event must clear its lease expiry');

  await Promise.all(childProcesses.map(stopChild));
  childProcesses.length = 0;

  const fenceMemory = createMemoryModule(await repository.load(context), async () => {});
  const fenceEvent = await fenceMemory.recordEvent(context, {
    eventId: `multiprocess-fence-${randomUUID()}`,
    content: 'lease takeover acceptance probe'
  });
  await repository.save(context, fenceMemory.state);
  const fenceOutboxId = fenceMemory.state.outboxEvents.find(item => item.aggregateId === fenceEvent.rawEventId)?.id;
  assert.ok(fenceOutboxId);
  const leaseStart = new Date();
  const first = await repository.claimOutboxEvent({ workerId: 'multiprocess-fence-a', leaseMs: 25, now: leaseStart, eventTypes: ['raw_event.created'] });
  assert.equal(first?.event?.id, fenceOutboxId);
  await sleep(40);
  const second = await repository.claimOutboxEvent({ workerId: 'multiprocess-fence-b', leaseMs: 30_000, now: new Date(), eventTypes: ['raw_event.created' ] });
  assert.equal(second?.event?.id, fenceOutboxId);
  assert.equal((await repository.finishOutboxEvent({ eventId: fenceOutboxId, workerId: 'multiprocess-fence-a', status: 'completed' })).updated, false);
  assert.equal((await repository.finishOutboxEvent({ eventId: fenceOutboxId, workerId: 'multiprocess-fence-b', status: 'completed' })).updated, true);

  const crashMemory = createMemoryModule(await repository.load(context), async () => {});
  const crashEvent = await crashMemory.recordEvent(context, {
    eventId: `multiprocess-crash-${randomUUID()}`,
    content: 'worker crash takeover acceptance probe'
  });
  await repository.save(context, crashMemory.state);
  const crashOutboxId = crashMemory.state.outboxEvents.find(item => item.aggregateId === crashEvent.rawEventId)?.id;
  assert.ok(crashOutboxId);
  const crashingWorker = spawn(process.execPath, ['scripts/memory-module-worker-process.js'], {
    cwd: root,
    env: { ...workerEnv, MEMORY_MODULE_WORKER_ID: 'multiprocess-worker-crash', MEMORY_MODULE_WORKER_CRASH_AFTER_CLAIM: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childProcesses.push(crashingWorker);
  await waitForLine(crashingWorker, 'acceptance_worker_ready', 'multiprocess-worker-crash');
  const takeoverWorker = spawn(process.execPath, ['scripts/memory-module-worker-process.js'], {
    cwd: root,
    env: { ...workerEnv, MEMORY_MODULE_WORKER_ID: 'multiprocess-worker-takeover' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childProcesses.push(takeoverWorker);
  await waitForLine(takeoverWorker, 'acceptance_worker_ready', 'multiprocess-worker-takeover');
  const crashExit = await waitForExit(crashingWorker, 'crashing worker');
  assert.equal(crashExit.signal, 'SIGKILL', 'crashing worker must terminate after claiming the event');
  const crashDeadline = Date.now() + 20_000;
  let crashLoaded;
  let crashOutbox;
  while (Date.now() < crashDeadline) {
    crashLoaded = await repository.load(context);
    crashOutbox = crashLoaded.outboxEvents.find(item => item.id === crashOutboxId);
    if (crashOutbox?.status === 'completed') break;
    await sleep(100);
  }
  assert.equal(crashOutbox?.status, 'completed', `crashed worker event was not recovered: ${crashOutbox?.status || 'missing'}`);
  assert.equal(Number(crashOutbox.attempts), 2, 'takeover worker must process once after the crashed claim');
  assert.equal(crashOutbox.leaseOwner, null);
  assert.equal(crashOutbox.leaseUntil, null);
  await Promise.all([stopChild(takeoverWorker)]);
  childProcesses.length = 0;

  console.log(JSON.stringify({
    event: 'memory_module_multiprocess_acceptance_passed',
    tenantId,
    workerProcesses: 2,
    singleConsumption: true,
    completedAttempts: Number(outbox.attempts),
    leaseTakeover: true,
    staleWorkerFenced: true,
    processCrashTakeover: true,
    crashAttempts: Number(crashOutbox.attempts)
  }));
} catch (error) {
  console.error(JSON.stringify({ event: 'memory_module_multiprocess_acceptance_failed', code: error.code || 'MEMORY_MULTIPROCESS_ACCEPTANCE_FAILED', message: error.message }));
  process.exitCode = 1;
} finally {
  await Promise.all(childProcesses.map(stopChild).map(promise => promise.catch(() => {})));
  try { await cleanup(); } catch (error) {
    console.error(JSON.stringify({ event: 'memory_module_multiprocess_acceptance_cleanup_failed', code: error.code || 'CLEANUP_FAILED' }));
    process.exitCode = 1;
  }
  await pool.end();
}
