import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { resolveDbSsl } from '../../server/db-ssl.js';

const { Pool } = pg;
const app = express();
const port = Number(process.env.MCP_PORT || process.env.PORT || 8790);
const serviceToken = process.env.MCP_SERVICE_TOKEN || '';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: resolveDbSsl(),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10000),
  statement_timeout: Number(process.env.DATABASE_QUERY_TIMEOUT_MS || 15000)
});

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  if (serviceToken && req.get('authorization') !== `Bearer ${serviceToken}`) return res.status(401).json({ error: { code: 'MCP_UNAUTHORIZED', message: 'Invalid MCP service token' } });
  next();
});

const tools = ['breath', 'hold', 'dream', 'grow', 'trace', 'list', 'get', 'update', 'remove', 'updateEvidence'];
const requireUser = args => {
  if (!args?.userId) throw Object.assign(new Error('userId is required'), { code: 'MCP_USER_REQUIRED' });
  return args.userId;
};
const parseRow = row => row ? ({ id: row.id, type: row.type, summary: row.summary, confidence: row.confidence, source: row.source, visibility: row.visibility, strength: row.strength, updatedAt: row.updated_at }) : null;

async function callTool(name, args = {}) {
  const userId = requireUser(args);
  if (name === 'breath' || name === 'list' || name === 'dream') {
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 5));
    const result = await pool.query('SELECT id,type,summary,confidence,source,visibility,strength,updated_at FROM cochpia_memories WHERE user_id=$1 ORDER BY strength DESC, updated_at DESC LIMIT $2', [userId, limit]);
    return result.rows.map(parseRow);
  }
  if (name === 'get' || name === 'trace') {
    const result = await pool.query('SELECT id,type,summary,confidence,source,visibility,strength,updated_at FROM cochpia_memories WHERE id=$1 AND user_id=$2', [args.id, userId]);
    return parseRow(result.rows[0]);
  }
  if (name === 'hold') {
    if (!String(args.summary || '').trim()) throw Object.assign(new Error('Memory summary is required'), { code: 'INVALID_MEMORY' });
    const result = await pool.query('INSERT INTO cochpia_memories (id,user_id,type,summary,confidence,source,visibility,strength,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id,type,summary,confidence,source,visibility,strength,updated_at', [randomUUID(), userId, args.type || 'event', String(args.summary).slice(0, 500), Math.max(0, Math.min(1, Number(args.confidence ?? 0.7))), args.source || 'mcp', args.visibility || 'shared', 0.72]);
    return parseRow(result.rows[0]);
  }
  if (name === 'update') {
    const result = await pool.query('UPDATE cochpia_memories SET type=COALESCE($3,type), summary=COALESCE($4,summary), confidence=COALESCE($5,confidence), visibility=COALESCE($6,visibility), updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id,type,summary,confidence,source,visibility,strength,updated_at', [args.id, userId, args.type, args.summary ? String(args.summary).slice(0, 500) : null, args.confidence, args.visibility]);
    return parseRow(result.rows[0]);
  }
  if (name === 'remove') {
    const result = await pool.query('DELETE FROM cochpia_memories WHERE id=$1 AND user_id=$2 RETURNING id', [args.id, userId]);
    return Boolean(result.rowCount);
  }
  if (name === 'grow') {
    const result = await pool.query('INSERT INTO cochpia_growth_evidence (id,user_id,type,claim,evidence,source_message_id,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id,type,claim,evidence,source_message_id,status,created_at', [randomUUID(), userId, args.type || 'observation', String(args.claim || '').slice(0, 300), String(args.evidence || '').slice(0, 500), args.sourceMessageId || null, 'draft']);
    return result.rows[0];
  }
  if (name === 'updateEvidence') {
    const result = await pool.query('UPDATE cochpia_growth_evidence SET status=$3, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *', [args.id, userId, args.status]);
    return result.rows[0] || null;
  }
  throw Object.assign(new Error(`Unknown memory tool: ${name}`), { code: 'MCP_TOOL_NOT_FOUND' });
}

app.get('/health', async (_, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'cochpia-memory-mcp' }); }
  catch (error) { res.status(503).json({ ok: false, code: 'MCP_STORAGE_UNAVAILABLE', message: error.message }); }
});

app.post('/', async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'cochpia-memory-mcp', version: '0.1.0' }, capabilities: { tools: {} } };
    else if (method === 'notifications/initialized') return res.status(202).end();
    else if (method === 'tools/list') result = { tools: tools.map(name => ({ name, description: `Cochpia memory tool: ${name}` })) };
    else if (method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(await callTool(params.name, params.arguments || {})) }] };
    else throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 'MCP_METHOD_NOT_FOUND' });
    res.json({ jsonrpc: '2.0', id, result });
  } catch (error) { res.status(500).json({ jsonrpc: '2.0', id, error: { code: error.code || -32000, message: error.message } }); }
});

app.listen(port, () => console.log(JSON.stringify({ event: 'memory_mcp_listening', port })));
