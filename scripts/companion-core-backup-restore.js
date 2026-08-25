import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';

const execFileAsync = promisify(execFile);
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.log(JSON.stringify({ event: 'companion_core_backup_restore_skipped', reason: 'DATABASE_URL_not_configured' }));
  process.exit(0);
}

const { Pool } = pg;
const source = new URL(sourceUrl);
const admin = new URL(sourceUrl);
admin.pathname = '/postgres';
const sourceDatabase = decodeURIComponent(source.pathname.slice(1));
const restoreDatabase = `cochpia_restore_${randomUUID().replaceAll('-', '')}`;
const probeTable = 'companion_backup_probe';
const probeId = `probe-${randomUUID()}`;
const probeValue = `backup-restore-${randomUUID()}`;
const dumpDirectory = await mkdtemp(path.join(os.tmpdir(), 'cochpia-backup-'));
const dumpPath = path.join(dumpDirectory, 'backup.dump');
const identifier = value => `"${String(value).replaceAll('"', '""')}"`;
const restoreUrl = new URL(sourceUrl);
restoreUrl.pathname = `/${restoreDatabase}`;

async function run(command, args) {
  return execFileAsync(command, args, { cwd: dumpDirectory, maxBuffer: 4 * 1024 * 1024 });
}

const sourcePool = new Pool({ connectionString: sourceUrl, ssl: resolveDbSsl(), max: 2, connectionTimeoutMillis: 10_000 });
const adminPool = new Pool({ connectionString: admin.toString(), ssl: resolveDbSsl(), max: 1, connectionTimeoutMillis: 10_000 });

try {
  await sourcePool.query(`CREATE TABLE IF NOT EXISTS ${identifier(probeTable)} (id text PRIMARY KEY, value text NOT NULL)`);
  await sourcePool.query(`INSERT INTO ${identifier(probeTable)} (id,value) VALUES ($1,$2)`, [probeId, probeValue]);
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dumpPath, sourceUrl]);
  await adminPool.query(`CREATE DATABASE ${identifier(restoreDatabase)}`);
  await run('pg_restore', ['--no-owner', '--no-acl', '--dbname', restoreUrl.toString(), dumpPath]);
  const restoredPool = new Pool({ connectionString: restoreUrl.toString(), ssl: resolveDbSsl(), max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const result = await restoredPool.query(`SELECT value FROM ${identifier(probeTable)} WHERE id=$1`, [probeId]);
    assert.equal(result.rows[0]?.value, probeValue, 'backup restore probe');
  } finally {
    await restoredPool.end();
  }
  console.log(JSON.stringify({ event: 'companion_core_backup_restore_passed', sourceDatabase, restoreDatabase, dumpFormat: 'custom', probeVerified: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'companion_core_backup_restore_failed', code: error.code || 'COMPANION_CORE_BACKUP_RESTORE_FAILED', message: error.message }));
  process.exitCode = 1;
} finally {
  await sourcePool.query(`DROP TABLE IF EXISTS ${identifier(probeTable)}`).catch(() => {});
  await adminPool.query(`DROP DATABASE IF EXISTS ${identifier(restoreDatabase)}`).catch(() => {});
  await sourcePool.end();
  await adminPool.end();
  await rm(dumpDirectory, { recursive: true, force: true }).catch(() => {});
}
