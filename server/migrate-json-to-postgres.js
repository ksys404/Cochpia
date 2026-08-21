import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveDbSsl } from './db-ssl.js';

const { Pool } = pg;
const root = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.join(root, 'data', 'state.json');
const userId = '00000000-0000-0000-0000-000000000001';
const schemaPath = path.join(root, 'normalized-schema.sql');

const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
const sessions = state.sessions || [];
const messages = Object.values(state.messages || {}).flat();
const memories = state.memories || [];
const evidence = state.evidence || [];
const versions = state.personalityHistory || [];

console.log(`Found ${sessions.length} sessions, ${messages.length} messages, ${memories.length} memories, ${evidence.length} evidence records, ${versions.length} personality versions.`);

if (process.argv.includes('--dry-run')) {
  console.log('Dry run only. No database connection or writes were performed.');
  process.exit(0);
}

if (process.env.STORAGE_PROVIDER !== 'postgres') throw new Error('Set STORAGE_PROVIDER=postgres before running the migration');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required before running the migration');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSsl(),
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(await fs.readFile(schemaPath, 'utf8'));
  await client.query('INSERT INTO cochpia_state (id, state, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()', [JSON.stringify(state)]);
  await client.query('INSERT INTO cochpia_users (id, external_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, 'local-user']);
  for (const session of sessions) {
    await client.query('INSERT INTO cochpia_sessions (id, user_id, title, model_provider, model_name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, model_provider=EXCLUDED.model_provider, model_name=EXCLUDED.model_name, updated_at=EXCLUDED.updated_at', [session.id, userId, session.title, session.modelProvider || 'mock', session.modelName || 'mock', session.createdAt, session.updatedAt]);
  }
  for (const message of messages) {
    const sessionId = Object.entries(state.messages || {}).find(([, items]) => items.some(item => item.id === message.id))?.[0];
    if (!sessionId) continue;
    await client.query('INSERT INTO cochpia_messages (id, session_id, role, content, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [message.id, sessionId, message.role, message.content, message.createdAt, message.updatedAt || null]);
  }
  for (const memory of memories) await client.query('INSERT INTO cochpia_memories (id,user_id,type,summary,confidence,source,visibility,strength,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING', [memory.id, userId, memory.type, memory.summary, memory.confidence, memory.source, memory.visibility, memory.strength, memory.updatedAt]);
  for (const version of versions) {
    const result = await client.query('INSERT INTO cochpia_personality_versions (user_id,version,summary,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,version) DO UPDATE SET summary=EXCLUDED.summary, updated_at=EXCLUDED.updated_at RETURNING id', [userId, version.version, version.summary || '', version.updatedAt]);
    for (const trait of version.traits || []) await client.query('INSERT INTO cochpia_personality_traits (version_id,trait_key,label,value) VALUES ($1,$2,$3,$4) ON CONFLICT (version_id,trait_key) DO UPDATE SET label=EXCLUDED.label,value=EXCLUDED.value', [result.rows[0].id, trait.key, trait.label, trait.value]);
  }
  for (const item of evidence) await client.query('INSERT INTO cochpia_growth_evidence (id,user_id,type,claim,evidence,source_message_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING', [item.id, userId, item.type, item.claim, item.evidence, item.sourceMessageId, item.status, item.createdAt, item.updatedAt || null]);
  await client.query('COMMIT');
  console.log('Migration completed.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
