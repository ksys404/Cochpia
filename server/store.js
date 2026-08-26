import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from './db-ssl.js';
import { createMemoryModuleState } from './memory-module.js';
import { DEFAULT_LIFE_STATE } from './life-state.js';
import { bumpCompanionDataRevision, ensureCompanionGovernanceState } from './companion-governance.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.COCHPIA_DATA_DIR || path.join(root, 'data'));
const stateFile = path.join(dataDir, 'state.json');
const storageProvider = String(process.env.STORAGE_PROVIDER || 'json').toLowerCase();
const { Pool } = pg;
let pool;
const storageStatus = { ready: false, lastError: null, lastLatencyMs: null, attempts: 0 };
const connectionTimeoutMs = Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10000);
const queryTimeoutMs = Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000);
const retryAttempts = Math.max(1, Number(process.env.STORAGE_RETRY_ATTEMPTS || 3));
const retryDelaysMs = [500, 1000, 2000];
const legacyNormalizedUserId = '00000000-0000-0000-0000-000000000001';

export class StorageError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'StorageError';
    this.code = code;
    this.status = code === 'STORAGE_CONFLICT' ? 409 : code.startsWith('STORAGE_') ? 503 : 500;
    this.retryable = code !== 'STORAGE_CONFLICT';
  }
}

function classifyStorageError(error) {
  if (error instanceof StorageError) return error;
  if (error?.code === 'STORAGE_CONFLICT') return error;
  if (error?.code === '40001' || error?.code === '23505' && /cochpia_user_states/i.test(error?.constraint || '')) return new StorageError('STORAGE_CONFLICT', 'Concurrent user state update conflicted', error);
  if (error?.code === '28P01') return new StorageError('STORAGE_AUTH_FAILED', 'Database authentication failed', error);
  if (error?.code === 'ENOTFOUND') return new StorageError('STORAGE_DNS_FAILED', 'Database host could not be resolved', error);
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET' || error?.code === 'ECONNREFUSED') return new StorageError('STORAGE_CONNECTION_FAILED', 'Database connection failed', error);
  if (error?.name === 'AbortError' || /timeout/i.test(error?.message || '')) return new StorageError('STORAGE_TIMEOUT', 'Database operation timed out', error);
  return new StorageError('STORAGE_OPERATION_FAILED', 'Database operation failed', error);
}

function logStorageError(error, operation, attempt) {
  const classified = classifyStorageError(error);
  storageStatus.lastError = { code: classified.code, operation, at: new Date().toISOString() };
  console.error(JSON.stringify({ event: 'storage_error', code: classified.code, operation, attempt }));
  return classified;
}

async function withRetry(operation, name) {
  let lastError;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    storageStatus.attempts = attempt;
    try {
      const startedAt = Date.now();
      const result = await operation();
      storageStatus.ready = true;
      storageStatus.lastError = null;
      storageStatus.lastLatencyMs = Date.now() - startedAt;
      return result;
    } catch (error) {
      lastError = logStorageError(error, name, attempt);
      if (!lastError.retryable) throw lastError;
      if (attempt < retryAttempts) await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt - 1] || retryDelaysMs.at(-1)));
    }
  }
  storageStatus.ready = false;
  throw lastError;
}

const initialState = {
  sessions: [{ id: 'welcome', title: '第一次相遇', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  messages: {
    welcome: [{ id: 'm-1', role: 'assistant', content: '你好，我是 Cochpia。这里会记录我们共同经历过的事，也会把变化保留成可以查看的证据。今天想从哪里开始？', createdAt: new Date().toISOString() }]
  },
  memoryModule: createMemoryModuleState(),
  personality: {
    version: 1,
    traits: [{ key: 'curiosity', label: '好奇心', value: 0.74 }, { key: 'warmth', label: '温度感', value: 0.68 }, { key: 'caution', label: '谨慎度', value: 0.42 }],
    summary: '温和、好奇，正在学习如何更准确地陪伴。',
    updatedAt: new Date().toISOString()
  },
  evidence: [],
  tasks: [],
  lifeState: structuredClone(DEFAULT_LIFE_STATE),
  relationshipStates: {},
  uploads: [],
  deletionRecords: [],
  personalityHistory: [],
  personalityAudit: [],
  personalityProjection: { appliedEvidenceIds: [], appliedSourceEventIds: [] },
  companion: { sessionMappings: {}, exportOperations: [], interactionOutbox: [], dataRevision: 0 }
};

export async function loadState() {
  if (storageProvider === 'postgres') return loadPostgresState();
  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    storageStatus.ready = true;
    storageStatus.lastError = null;
    return state;
  } catch {
    await saveState(initialState);
    storageStatus.ready = true;
    return structuredClone(initialState);
  }
}

export async function saveState(state, { bumpCommitSequence = true } = {}) {
  const hadCompanion = Boolean(state?.companion);
  const previousRevision = state?.companion?.dataRevision;
  if (bumpCommitSequence) bumpCompanionDataRevision(state);
  else ensureCompanionGovernanceState(state);
  try {
    if (storageProvider === 'postgres') return state?.__userId && state.__userId !== 'local-user' ? saveUserState(state.__userId, state) : savePostgresState(state);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    if (bumpCommitSequence) {
      if (hadCompanion) state.companion.dataRevision = previousRevision;
      else delete state.companion;
    }
    throw error;
  }
}

async function getPostgresPool() {
  if (!process.env.DATABASE_URL) throw new StorageError('DATABASE_URL_REQUIRED', 'DATABASE_URL is required when STORAGE_PROVIDER=postgres');
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) throw new Error('Invalid PostgreSQL URL');
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('DATABASE_CONFIGURATION_INVALID', 'DATABASE_URL must be a valid PostgreSQL connection URL', error);
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: resolveDbSsl(),
      connectionTimeoutMillis: connectionTimeoutMs,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      max: Number(process.env.DATABASE_POOL_MAX || 10)
    });
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS cochpia_state (id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
      await pool.query('CREATE TABLE IF NOT EXISTS cochpia_user_states (user_id text PRIMARY KEY, state jsonb NOT NULL, resource_revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())');
      await pool.query('ALTER TABLE cochpia_user_states ADD COLUMN IF NOT EXISTS resource_revision bigint NOT NULL DEFAULT 1');
      await pool.query('CREATE TABLE IF NOT EXISTS cochpia_legacy_claim (id integer PRIMARY KEY CHECK (id = 1), user_id text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now())');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS cochpia_chat_stream_runs (
          user_id text NOT NULL,
          run_id text NOT NULL,
          session_id text NOT NULL,
          attempt integer NOT NULL DEFAULT 1,
          state text NOT NULL,
          events jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          expires_at timestamptz NOT NULL,
          PRIMARY KEY (user_id, run_id)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS cochpia_chat_stream_runs_expiry_idx ON cochpia_chat_stream_runs (expires_at)');
    } catch (error) {
      await pool.end().catch(() => {});
      pool = undefined;
      throw error;
    }
  }
  return pool;
}

async function loadPostgresState() {
  return withRetry(async () => {
    const database = await getPostgresPool();
    const result = await database.query('SELECT state FROM cochpia_state WHERE id = 1');
    if (result.rows[0]?.state) return result.rows[0].state;
    const state = structuredClone(initialState);
    await savePostgresState(state);
    return state;
  }, 'load');
}

async function savePostgresState(state) {
  return withRetry(async () => {
    const database = await getPostgresPool();
    await database.query('INSERT INTO cochpia_state (id, state, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [JSON.stringify(state)]);
  }, 'save');
}

function emptyUserState(baseState) {
  const next = structuredClone(baseState);
  next.sessions = [];
  next.messages = {};
  next.memoryModule = createMemoryModuleState();
  next.memories = [];
  next.evidence = [];
  next.tasks = [];
  next.events = [];
  next.agents = [];
  next.personality = structuredClone(initialState.personality);
  next.personalityHistory = [];
  next.personalityAudit = [];
  next.personalityProjection = { appliedEvidenceIds: [], appliedSourceEventIds: [] };
  next.lifeState = structuredClone(DEFAULT_LIFE_STATE);
  next.relationshipStates = {};
  next.uploads = [];
  next.companion = { sessionMappings: {}, exportOperations: [], interactionOutbox: [], dataRevision: 0 };
  next.deletionRecords = [];
  next.workspacePreferences = null;
  next.workspacePreferencesUpdatedAt = null;
  return next;
}

function attachStorageRevision(state, revision, userId = null) {
  Object.defineProperty(state, '__storageRevision', { value: Math.max(1, Number(revision) || 1), enumerable: false, configurable: true, writable: true });
  if (userId) Object.defineProperty(state, '__userId', { value: String(userId), enumerable: false, configurable: true, writable: false });
  return state;
}

export async function loadUserState(userId, baseState) {
  if (storageProvider !== 'postgres' || userId === 'local-user') return baseState;
  return withRetry(async () => {
    const database = await getPostgresPool();
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`cochpia:user-state:${userId}`]);
      const existing = await client.query('SELECT state, resource_revision FROM cochpia_user_states WHERE user_id=$1', [userId]);
      if (existing.rows[0]?.state) {
        await client.query('COMMIT');
        return attachStorageRevision(existing.rows[0].state, existing.rows[0].resource_revision, userId);
      }
      const claimed = await client.query('SELECT user_id FROM cochpia_legacy_claim WHERE id=1 FOR UPDATE');
      const next = claimed.rows[0] ? emptyUserState(baseState) : structuredClone(baseState);
      await client.query('INSERT INTO cochpia_user_states (user_id,state,resource_revision) VALUES ($1,$2::jsonb,1) ON CONFLICT (user_id) DO NOTHING', [userId, JSON.stringify(next)]);
      const inserted = await client.query('SELECT state, resource_revision FROM cochpia_user_states WHERE user_id=$1', [userId]);
      if (!inserted.rows[0]) throw new StorageError('STORAGE_OPERATION_FAILED', 'User state could not be initialized');
      if (!claimed.rows[0]) {
        const legacyTables = await client.query(`
          SELECT to_regclass('public.cochpia_users') IS NOT NULL AS users_ready,
                 to_regclass('public.cochpia_sessions') IS NOT NULL AS sessions_ready,
                 to_regclass('public.cochpia_memories') IS NOT NULL AS memories_ready,
                 to_regclass('public.cochpia_personality_versions') IS NOT NULL AS personality_ready,
                 to_regclass('public.cochpia_growth_evidence') IS NOT NULL AS evidence_ready
        `);
        const tables = legacyTables.rows[0] || {};
        if (tables.users_ready) await client.query('INSERT INTO cochpia_users (id, external_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [userId, `supabase:${userId}`]);
        if (tables.sessions_ready) await client.query('UPDATE cochpia_sessions SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        if (tables.memories_ready) await client.query('UPDATE cochpia_memories SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        if (tables.personality_ready) await client.query('UPDATE cochpia_personality_versions SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        if (tables.evidence_ready) await client.query('UPDATE cochpia_growth_evidence SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        await client.query('INSERT INTO cochpia_legacy_claim (id,user_id) VALUES (1,$1) ON CONFLICT (id) DO NOTHING', [userId]);
      }
      await client.query('COMMIT');
      return attachStorageRevision(inserted.rows[0].state, inserted.rows[0].resource_revision, userId);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }, 'load_user');
}

async function saveUserState(userId, state) {
  return withRetry(async () => {
    const database = await getPostgresPool();
    const expectedRevision = Math.max(1, Number(state?.__storageRevision) || 1);
    const result = await database.query(`
      INSERT INTO cochpia_user_states (user_id,state,resource_revision,updated_at)
      VALUES ($1,$2::jsonb,$3,now())
      ON CONFLICT (user_id) DO UPDATE
        SET state=EXCLUDED.state, resource_revision=cochpia_user_states.resource_revision + 1, updated_at=now()
      WHERE cochpia_user_states.resource_revision=$3
      RETURNING resource_revision
    `, [userId, JSON.stringify(state), expectedRevision]);
    if (!result.rows[0]) throw new StorageError('STORAGE_CONFLICT', 'Concurrent user state update conflicted');
    attachStorageRevision(state, result.rows[0].resource_revision, userId);
  }, 'save_user');
}

function mapChatStreamRun(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    runId: row.run_id,
    sessionId: row.session_id,
    attempt: Number(row.attempt) || 1,
    state: row.state,
    events: Array.isArray(row.events) ? row.events : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString()
  };
}

export async function createChatStreamRunRecord(record) {
  if (storageProvider !== 'postgres') return null;
  return withRetry(async () => {
    const database = await getPostgresPool();
    await database.query('DELETE FROM cochpia_chat_stream_runs WHERE expires_at <= now()');
    const result = await database.query(`
      INSERT INTO cochpia_chat_stream_runs (user_id,run_id,session_id,attempt,state,events,expires_at)
      VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6::timestamptz)
      ON CONFLICT (user_id,run_id) DO UPDATE
        SET session_id=EXCLUDED.session_id, attempt=EXCLUDED.attempt, state=EXCLUDED.state,
            events='[]'::jsonb, updated_at=now(), expires_at=EXCLUDED.expires_at
      RETURNING user_id,run_id,session_id,attempt,state,events,created_at,updated_at,expires_at
    `, [record.userId, record.runId, record.sessionId || '', record.attempt || 1, record.state || 'streaming', record.expiresAt]);
    return mapChatStreamRun(result.rows[0]);
  }, 'chat_stream_create');
}

export async function appendChatStreamEventRecord({ userId, runId, entry, maxEvents = 5_000, updatedAt = new Date().toISOString() } = {}) {
  if (storageProvider !== 'postgres') return null;
  return withRetry(async () => {
    const database = await getPostgresPool();
    const result = await database.query(`
      WITH appended AS (
        SELECT events || $3::jsonb AS all_events
        FROM cochpia_chat_stream_runs
        WHERE user_id=$1 AND run_id=$2 AND expires_at > now()
      ), trimmed AS (
        SELECT COALESCE(
          jsonb_agg(value ORDER BY ord) FILTER (
            WHERE ord > GREATEST(jsonb_array_length(all_events) - $4::integer, 0)
          ), '[]'::jsonb
        ) AS events
        FROM appended, jsonb_array_elements(all_events) WITH ORDINALITY AS items(value, ord)
      )
      UPDATE cochpia_chat_stream_runs
      SET events=(SELECT events FROM trimmed), updated_at=$5::timestamptz
      WHERE user_id=$1 AND run_id=$2 AND expires_at > now()
      RETURNING user_id,run_id,session_id,attempt,state,events,created_at,updated_at,expires_at
    `, [userId, runId, JSON.stringify([entry]), Math.max(100, Number(maxEvents) || 5_000), updatedAt]);
    return mapChatStreamRun(result.rows[0]);
  }, 'chat_stream_append');
}

export async function finishChatStreamRunRecord({ userId, runId, state = 'completed', expiresAt, updatedAt = new Date().toISOString() } = {}) {
  if (storageProvider !== 'postgres') return null;
  return withRetry(async () => {
    const database = await getPostgresPool();
    const result = await database.query(`
      UPDATE cochpia_chat_stream_runs
      SET state=$3, expires_at=$4::timestamptz, updated_at=$5::timestamptz
      WHERE user_id=$1 AND run_id=$2
      RETURNING user_id,run_id,session_id,attempt,state,events,created_at,updated_at,expires_at
    `, [userId, runId, state, expiresAt, updatedAt]);
    return mapChatStreamRun(result.rows[0]);
  }, 'chat_stream_finish');
}

export async function loadChatStreamRunRecord({ userId, runId } = {}) {
  if (storageProvider !== 'postgres') return null;
  return withRetry(async () => {
    const database = await getPostgresPool();
    const result = await database.query(`
      SELECT user_id,run_id,session_id,attempt,state,events,created_at,updated_at,expires_at
      FROM cochpia_chat_stream_runs
      WHERE user_id=$1 AND run_id=$2 AND expires_at > now()
    `, [userId, runId]);
    return mapChatStreamRun(result.rows[0]);
  }, 'chat_stream_load');
}

export async function removeChatStreamRunRecords({ userId, runId = null, sessionId = null } = {}) {
  if (storageProvider !== 'postgres') return 0;
  return withRetry(async () => {
    const database = await getPostgresPool();
    let result;
    if (runId) result = await database.query('DELETE FROM cochpia_chat_stream_runs WHERE user_id=$1 AND run_id=$2', [userId, runId]);
    else if (sessionId) result = await database.query('DELETE FROM cochpia_chat_stream_runs WHERE user_id=$1 AND session_id=$2', [userId, sessionId]);
    else result = await database.query('DELETE FROM cochpia_chat_stream_runs WHERE user_id=$1', [userId]);
    return result.rowCount || 0;
  }, 'chat_stream_remove');
}

export async function pruneChatStreamRunRecords() {
  if (storageProvider !== 'postgres') return 0;
  return withRetry(async () => {
    const database = await getPostgresPool();
    const result = await database.query('DELETE FROM cochpia_chat_stream_runs WHERE expires_at <= now()');
    return result.rowCount || 0;
  }, 'chat_stream_prune');
}

export function getStorageStatus() {
  return { provider: storageProvider, ...storageStatus };
}

export { dataDir, storageProvider, emptyUserState };
