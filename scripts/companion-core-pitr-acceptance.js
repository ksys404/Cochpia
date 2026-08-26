import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { appendFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createMemoryModule } from '../server/memory-module.js';
import { createMemoryModulePostgresRepository } from '../server/memory-module-postgres.js';
import { applyMemoryModuleSchema } from '../server/memory-module-pg-migration.js';
import { replayRedactionLedger } from '../server/memory-module-recovery.js';

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const postgresBin = process.env.PG_BIN_DIR || '/opt/homebrew/opt/postgresql@17/bin';
const binary = name => path.join(postgresBin, name);
const run = async (file, args, options = {}) => execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024, ...options });
const runQuiet = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'ignore' });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`${path.basename(file)} exited with ${code ?? signal}`));
  });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sqlQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const progress = stage => console.error(JSON.stringify({ event: 'companion_core_pitr_progress', stage }));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error('PITR readiness timeout');
}

async function startPostgres(dataDir, port, logPath) {
  await runQuiet(binary('pg_ctl'), ['-D', dataDir, '-l', logPath, '-o', `-p ${port}`, '-w', 'start']);
}

async function stopPostgres(dataDir) {
  await runQuiet(binary('pg_ctl'), ['-D', dataDir, '-m', 'fast', '-w', 'stop']).catch(() => {});
}

async function archivedFiles(archiveDir) {
  const { stdout } = await run('/bin/ls', ['-1', archiveDir], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').map(item => item.trim()).filter(item => item && item !== '.keep');
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cochpia-pitr-'));
  const primaryData = path.join(root, 'primary');
  const recoveryData = path.join(root, 'recovery');
  const baseBackup = path.join(root, 'base-backup');
  const archiveDir = path.join(root, 'archive');
  const primaryPort = await freePort();
  const recoveryPort = await freePort();
  const osUser = os.userInfo().username;
  const tenantId = `pitr-${randomUUID()}`;
  const subjectUserId = `pitr-${randomUUID()}`;
  const context = { tenantId, subjectUserId, actorType: 'user', actorId: subjectUserId, callerAgentId: 'cochpia' };
  const sourceEventId = `pitr-source-${randomUUID()}`;
  const deleteIdempotencyKey = `pitr-delete-${randomUUID()}`;
  let primaryPool = null;
  let recoveryPool = null;
  let primaryStarted = false;
  let recoveryStarted = false;

  try {
    progress('initdb');
    await run(binary('initdb'), ['-D', primaryData, '--no-locale', '--encoding=UTF8', `--username=${osUser}`, '--auth-local=trust', '--auth-host=trust']);
    await writeFile(path.join(primaryData, 'pg_hba.conf'), [
      'local all all trust',
      'host all all 127.0.0.1/32 trust',
      'host replication all 127.0.0.1/32 trust',
      ''
    ].join('\n'));
    await mkdir(archiveDir, { recursive: true });
    await writeFile(path.join(archiveDir, '.keep'), '');
    await appendFile(path.join(primaryData, 'postgresql.conf'), [
      'listen_addresses = \'127.0.0.1\'',
      `port = ${primaryPort}`,
      'wal_level = replica',
      'max_wal_senders = 4',
      'archive_mode = on',
      `archive_command = ${sqlQuote(`/bin/cp "%p" "${archiveDir}/%f"`)}`,
      'full_page_writes = on',
      'fsync = on',
      ''
    ].join('\n'));
    progress('start-primary');
    await startPostgres(primaryData, primaryPort, path.join(root, 'primary.log'));
    primaryStarted = true;

    const primaryUrl = `postgresql://${encodeURIComponent(osUser)}@127.0.0.1:${primaryPort}/postgres`;
    primaryPool = new Pool({ connectionString: primaryUrl, max: 4, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 30_000 });
    primaryPool.on('error', error => console.error(JSON.stringify({ event: 'companion_core_pitr_pool_error', pool: 'primary', code: error.code || 'PG_POOL_ERROR' })));
    await primaryPool.query('SELECT 1');
    progress('apply-schema');
    const schema = await readFile(path.resolve('server/memory-module-schema.sql'), 'utf8');
    await applyMemoryModuleSchema(primaryPool, { schema });

    const repository = createMemoryModulePostgresRepository(primaryPool);
    progress('seed');
    let state = await repository.load(context);
    let memory = createMemoryModule(state, async () => {});
    const source = await memory.recordEvent(context, {
      eventId: sourceEventId,
      content: 'PITR recovery probe source event'
    });
    const assertion = await memory.hold(context, {
      content: 'PITR recovery probe assertion',
      memoryType: 'pitr_probe',
      sensitivity: 'S0',
      sourceEventId: source.rawEventId
    });
    await repository.save(context, memory.state);
    const knownAssertionId = assertion.memory.memoryId;
    const knownRawEventId = source.rawEventId;
    assert.ok(knownRawEventId);
    assert.ok(knownAssertionId);

    await primaryPool.query('CHECKPOINT');
    await primaryPool.query('SELECT pg_switch_wal()');
    progress('wait-initial-archive');
    await waitFor(async () => (await archivedFiles(archiveDir)).length > 0);

    progress('base-backup');
    await run(binary('pg_basebackup'), [
      '-h', '127.0.0.1',
      '-p', String(primaryPort),
      '-U', osUser,
      '-D', baseBackup,
      '-Fp',
      '-X', 'stream',
      '-P'
    ]);
    const targetResult = await primaryPool.query("SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.USOF') AS now");
    const recoveryTargetTime = targetResult.rows[0].now;
    await sleep(1_000);

    progress('delete-after-backup');
    state = await repository.load(context);
    memory = createMemoryModule(state, async () => {});
    await memory.deleteSourceEvent(context, knownRawEventId, { resourceRevision: 1, idempotencyKey: deleteIdempotencyKey });
    await repository.save(context, memory.state);
    const deletedAtResult = await primaryPool.query('SELECT clock_timestamp() AS now');
    const deletionLedger = memory.state.tombstones.filter(item => item.targetType === 'source_event' && item.targetId === knownRawEventId);
    assert.equal(deletionLedger.length > 0, true, 'source-event deletion must create a tombstone ledger entry');
    await primaryPool.query('CHECKPOINT');
    await primaryPool.query('SELECT pg_switch_wal()');
    progress('wait-delete-archive');
    await waitFor(async () => (await archivedFiles(archiveDir)).length > 1);

    progress('stop-primary');
    await primaryPool.end();
    primaryPool = null;
    await stopPostgres(primaryData);
    primaryStarted = false;
    await cp(baseBackup, recoveryData, { recursive: true });
    await appendFile(path.join(recoveryData, 'postgresql.conf'), [
      'listen_addresses = \'127.0.0.1\'',
      `port = ${recoveryPort}`,
      `restore_command = ${sqlQuote(`/bin/cp "${archiveDir}/%f" "%p"`)}`,
      `recovery_target_time = ${sqlQuote(recoveryTargetTime)}`,
      'recovery_target_inclusive = off',
      'recovery_target_action = pause',
      ''
    ].join('\n'));
    await writeFile(path.join(recoveryData, 'recovery.signal'), '');
    progress('start-recovery');
    await startPostgres(recoveryData, recoveryPort, path.join(root, 'recovery.log'));
    recoveryStarted = true;

    const recoveryUrl = `postgresql://${encodeURIComponent(osUser)}@127.0.0.1:${recoveryPort}/postgres`;
    recoveryPool = new Pool({ connectionString: recoveryUrl, max: 4, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 30_000 });
    recoveryPool.on('error', error => console.error(JSON.stringify({ event: 'companion_core_pitr_pool_error', pool: 'recovery', code: error.code || 'PG_POOL_ERROR' })));
    progress('wait-recovery-target');
    await waitFor(async () => {
      const result = await recoveryPool.query('SELECT pg_is_in_recovery() AS in_recovery, (SELECT COUNT(*) FROM raw_events WHERE id=$1) AS raw_count', [knownRawEventId]);
      return result.rows[0]?.in_recovery === true && Number(result.rows[0]?.raw_count) === 1;
    }, { timeoutMs: 60_000 });
    await run(binary('pg_ctl'), ['-D', recoveryData, 'promote', '-w']);
    progress('replay-ledger');
    await waitFor(async () => {
      const result = await recoveryPool.query('SELECT pg_is_in_recovery() AS in_recovery');
      return result.rows[0]?.in_recovery === false;
    });

    const recoveryRepository = createMemoryModulePostgresRepository(recoveryPool);
    const recoveredState = await recoveryRepository.load(context);
    assert.equal(recoveredState.rawEvents.some(item => item.id === knownRawEventId), true, 'PITR must restore the pre-delete source event');
    recoveredState.tombstones ||= [];
    for (const tombstone of deletionLedger) {
      if (!recoveredState.tombstones.some(item => item.id === tombstone.id)) recoveredState.tombstones.push(structuredClone(tombstone));
    }
    const replay = replayRedactionLedger(recoveredState);
    await recoveryRepository.save(context, recoveredState);
    const replayedState = await recoveryRepository.load(context);
    assert.equal(replayedState.rawEvents.some(item => item.id === knownRawEventId), false);
    assert.equal(replayedState.assertions.some(item => item.id === knownAssertionId), false);
    assert.equal(replayedState.indexDocuments.some(item => item.sourceId === knownAssertionId), false);
    assert.equal(replayedState.outboxEvents.some(item => item.aggregateId === knownRawEventId), false);
    const replayedMemory = createMemoryModule(replayedState, async () => {});
    const retrieved = replayedMemory.retrieve(context, { query: 'PITR recovery probe', purpose: 'profile_view' });
    assert.equal(retrieved.items.some(item => item.memoryId === knownAssertionId), false);

    const deletedAt = new Date(deletedAtResult.rows[0].now).getTime();
    const targetAt = new Date(recoveryTargetTime).getTime();
    console.log(JSON.stringify({
      event: 'companion_core_pitr_acceptance_passed',
      backupRestore: true,
      recoveryTargetBeforeDeletion: targetAt < deletedAt,
      deletionLedgerReplayed: replay.applied >= 0,
      negativeRead: true,
      rawEventRemoved: true,
      assertionRemoved: true,
      indexRemoved: true,
      outboxRemoved: true,
      rpoWindowMs: deletedAt - targetAt
    }));
  } catch (error) {
    const diagnostics = {};
    for (const [name, file] of [['primary', path.join(root, 'primary.log')], ['recovery', path.join(root, 'recovery.log')]]) {
      try { diagnostics[name] = (await readFile(file, 'utf8')).slice(-6000); } catch { /* no log was created */ }
    }
    console.error(JSON.stringify({ event: 'companion_core_pitr_acceptance_failed', code: error.code || 'COMPANION_CORE_PITR_ACCEPTANCE_FAILED', message: error.message, detail: error.detail, diagnostics }));
    process.exitCode = 1;
  } finally {
    if (recoveryPool) await recoveryPool.end().catch(() => {});
    if (primaryPool) await primaryPool.end().catch(() => {});
    if (recoveryStarted) await stopPostgres(recoveryData);
    if (primaryStarted) await stopPostgres(primaryData);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
