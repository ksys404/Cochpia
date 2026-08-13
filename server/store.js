import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from './db-ssl.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
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
  }
}

function classifyStorageError(error) {
  if (error instanceof StorageError) return error;
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
  memories: [
    { id: 'mem-1', type: 'relationship', summary: 'Cochpia 正在与用户建立一段可持续、可回溯的关系。', confidence: 0.94, source: 'system', visibility: 'shared', strength: 0.82, importance: 0.9, valence: 0.6, arousal: 0.4, updatedAt: new Date().toISOString() }
  ],
  personality: {
    version: 1,
    traits: [{ key: 'curiosity', label: '好奇心', value: 0.74 }, { key: 'warmth', label: '温度感', value: 0.68 }, { key: 'caution', label: '谨慎度', value: 0.42 }],
    summary: '温和、好奇，正在学习如何更准确地陪伴。',
    updatedAt: new Date().toISOString()
  },
  evidence: [],
  tasks: []
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

export async function saveState(state) {
  if (storageProvider === 'postgres') return state?.__userId && state.__userId !== 'local-user' ? saveUserState(state.__userId, state) : savePostgresState(state);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
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
  next.memories = [];
  next.evidence = [];
  return next;
}

export async function loadUserState(userId, baseState) {
  if (storageProvider !== 'postgres' || userId === 'local-user') return baseState;
  return withRetry(async () => {
    const database = await getPostgresPool();
    await database.query('CREATE TABLE IF NOT EXISTS cochpia_user_states (user_id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    await database.query('CREATE TABLE IF NOT EXISTS cochpia_legacy_claim (id integer PRIMARY KEY CHECK (id = 1), user_id text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now())');
    const existing = await database.query('SELECT state FROM cochpia_user_states WHERE user_id=$1', [userId]);
    if (existing.rows[0]?.state) return existing.rows[0].state;
    const claimed = await database.query('SELECT user_id FROM cochpia_legacy_claim WHERE id=1');
    const next = claimed.rows[0] ? emptyUserState(baseState) : structuredClone(baseState);
    await database.query('BEGIN');
    try {
      await database.query('INSERT INTO cochpia_user_states (user_id,state) VALUES ($1,$2::jsonb) ON CONFLICT (user_id) DO NOTHING', [userId, JSON.stringify(next)]);
      if (!claimed.rows[0]) {
        await database.query('INSERT INTO cochpia_users (id, external_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [userId, `supabase:${userId}`]);
        await database.query('UPDATE cochpia_sessions SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        await database.query('UPDATE cochpia_memories SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        await database.query('UPDATE cochpia_personality_versions SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        await database.query('UPDATE cochpia_growth_evidence SET user_id=$1 WHERE user_id=$2', [userId, legacyNormalizedUserId]);
        await database.query('INSERT INTO cochpia_legacy_claim (id,user_id) VALUES (1,$1) ON CONFLICT (id) DO NOTHING', [userId]);
      }
      await database.query('COMMIT');
    } catch (error) { await database.query('ROLLBACK'); throw error; }
    return next;
  }, 'load_user');
}

async function saveUserState(userId, state) {
  return withRetry(async () => {
    const database = await getPostgresPool();
    await database.query('INSERT INTO cochpia_user_states (user_id,state,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()', [userId, JSON.stringify(state)]);
  }, 'save_user');
}

export function getStorageStatus() {
  return { provider: storageProvider, ...storageStatus };
}

export { dataDir, storageProvider };
