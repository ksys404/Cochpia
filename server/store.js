import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from './db-ssl.js';
import { createMemoryModuleState } from './memory-module.js';

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
// 用户 state 内存缓存：跨地域 DB 单次查询约几十秒，缓存可让读请求基本秒回。
const userStateCache = new Map();
const userStateCacheTtlMs = Math.max(1000, Number(process.env.USER_STATE_CACHE_TTL_MS) || 30_000);

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
  // 只补原始错误码(如 22P02)。别把 PG 的 message 记进去:它可能带上参数值,那是用户数据。
  const causeCode = error !== classified && error?.code ? String(error.code) : null;
  console.error(JSON.stringify({ event: 'storage_error', code: classified.code, operation, attempt, causeCode }));
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
  sessions: [],
  messages: {},
  memoryModule: createMemoryModuleState(),
  evidence: [],
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

// 哪些键可以从 base state 继承给新用户。
// 目前**故意为空**:base state(单用户时代遗留)里只有上一个用户的内容(画像/角色/记忆/内在状态),
// 没有任何应用级共享配置。将来若要共享某项配置,必须显式加进来 —— 默认不继承。
const INHERITED_STATE_KEYS = Object.freeze([]);
const EMPTY_USER_PROFILE = Object.freeze({ name: '', gender: 'none', age: null, avatar: '✦' });

/**
 * 按用户分表后,新用户的状态曾经是 structuredClone(baseState) 再清掉几个字段 ——
 * 结果是把上一位用户的画像/立绘/角色/记忆整包发给了新注册用户(实测已在第二个账号上发生)。
 * 这里改成 fail-closed:只保留显式的应用级键,其余一律从规范空值重建。
 */
export function emptyUserState(baseState) {
  const inherited = {};
  for (const key of INHERITED_STATE_KEYS) {
    if (baseState && Object.hasOwn(baseState, key)) inherited[key] = structuredClone(baseState[key]);
  }
  return {
    ...inherited,
    mode: 'companion',
    profile: { ...EMPTY_USER_PROFILE },
    sessions: [],
    messages: {},
    memories: [],
    evidence: [],
    agents: [],
    agentTasks: [],
    proposals: [],
    events: [],
    // routes/workflows.js 会直接 state.collaborationRuns.push(run)(没有守卫),必须给空数组
    collaborationRuns: [],
    memoryModule: createMemoryModuleState()
  };
}

export async function loadUserState(userId, baseState) {
  if (storageProvider !== 'postgres' || userId === 'local-user') return baseState;
  const cached = userStateCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return JSON.parse(cached.json);
  const state = await withRetry(async () => {
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
  userStateCache.set(userId, { json: JSON.stringify(state), expiresAt: Date.now() + userStateCacheTtlMs });
  return state;
}

async function saveUserState(userId, state) {
  const json = JSON.stringify(state);
  await withRetry(async () => {
    const database = await getPostgresPool();
    await database.query('INSERT INTO cochpia_user_states (user_id,state,updated_at) VALUES ($1,$2::jsonb,now()) ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()', [userId, json]);
  }, 'save_user');
  userStateCache.set(userId, { json, expiresAt: Date.now() + userStateCacheTtlMs });
}

// 历史迁移脚本写入过的按用户分表。运行时只读 cochpia_user_states,
// 但擦除时必须一并清掉,否则迁移过的数据会残留。
const LEGACY_USER_TABLES = ['cochpia_sessions', 'cochpia_memories', 'cochpia_personality_versions', 'cochpia_growth_evidence'];

/**
 * 账号级擦除:删掉该用户名下的全部应用数据(PG 行级删除)并清本地缓存。
 * 内存模块的 state 本身就存在 cochpia_user_states 里,所以删行即物理擦除。
 * 只支持 postgres:JSON 模式是单用户开发态,不存在「某个账号的数据」这种边界。
 */
export async function deleteUserState(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new StorageError('ACCOUNT_USER_ID_REQUIRED', 'A user id is required to erase account data');
  if (id === 'local-user') throw new StorageError('ACCOUNT_LOCAL_NOT_ERASABLE', 'The local development account cannot be erased through this endpoint');
  if (storageProvider !== 'postgres') throw new StorageError('ACCOUNT_ERASURE_UNSUPPORTED', 'Account erasure requires STORAGE_PROVIDER=postgres');
  userStateCache.delete(id);
  const removed = await withRetry(async () => {
    const database = await getPostgresPool();
    const result = { userStates: 0, users: 0, legacyRows: {} };
    // 统一用 <column>::text = $1 比较:这几张表的 id/user_id 类型不一致(text 与 uuid 混用),
    // 直接把参数拿去比 uuid 列会在非 uuid 主体上抛 22P02 —— 而擦除必须永远能跑完。
    result.userStates = (await database.query('DELETE FROM cochpia_user_states WHERE user_id::text = $1', [id])).rowCount;
    if ((await database.query('SELECT to_regclass($1) AS name', ['cochpia_users'])).rows[0]?.name) {
      result.users = (await database.query('DELETE FROM cochpia_users WHERE id::text = $1', [id])).rowCount;
    }
    for (const table of LEGACY_USER_TABLES) {
      if (!(await database.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name) continue;
      result.legacyRows[table] = (await database.query(`DELETE FROM ${table} WHERE user_id::text = $1`, [id])).rowCount;
    }
    return result;
  }, 'delete_user');
  // 擦除后立刻重新载入会得到 emptyUserState(legacy claim 已存在),不会把旧数据读回来。
  userStateCache.delete(id);
  return removed;
}

export function getStorageStatus() {
  return { provider: storageProvider, ...storageStatus };
}

export { dataDir, storageProvider };
