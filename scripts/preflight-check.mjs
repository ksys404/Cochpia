#!/usr/bin/env node
// 上线前自检。把「发布/部署前必须确认的事」变成可反复跑的检查。
//
//   node scripts/preflight-check.mjs            # 全量
//   node scripts/preflight-check.mjs --no-db    # 跳过数据库连接检查
//
// 退出码:0 = 没有 ❌(可能有 ⚠️);1 = 存在 ❌。
// 不打印任何密钥明文,只报告"是否设置"和脱敏后的主机名。
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDbSsl } from '../server/db-ssl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipDb = process.argv.includes('--no-db');
const env = process.env;
const results = [];
const ok = (area, message) => results.push({ level: 'ok', area, message });
const warn = (area, message) => results.push({ level: 'warn', area, message });
const bad = (area, message) => results.push({ level: 'bad', area, message });

const isProd = String(env.NODE_ENV || '').toLowerCase() === 'production';
const readFile = file => { try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; } };
const listTracked = pattern => { try { return execSync(`git ls-files "${pattern}"`, { cwd: root }).toString().trim(); } catch { return ''; } };

// ─────────────────────── 1. 基础配置 ───────────────────────
if (!isProd) {
  warn('配置', `NODE_ENV=${env.NODE_ENV || '(未设置)'} —— 生产守卫全部依赖 NODE_ENV=production:`
    + '生产拒绝 mock 模型、dev 路由 404、HSTS、关闭观测记录、关闭不可信 agent header。上线前务必设为 production。');
} else {
  ok('配置', 'NODE_ENV=production(生产守卫生效)');
}
if (String(env.AUTH_MODE || '').toLowerCase() === 'required') ok('配置', 'AUTH_MODE=required');
else bad('配置', `AUTH_MODE=${env.AUTH_MODE || '(未设置)'} —— 生产必须是 required,否则 API 对匿名开放`);
if (env.APP_VERSION) ok('配置', `APP_VERSION=${env.APP_VERSION}`);
else warn('配置', 'APP_VERSION 未设置(/api/version 会回退默认值)');

const origins = String(env.CLIENT_ORIGIN || '').split(',').map(item => item.trim()).filter(Boolean);
if (!origins.length) bad('配置', 'CLIENT_ORIGIN 未设置');
else if (origins.some(origin => origin.startsWith('https://'))) ok('配置', `CLIENT_ORIGIN 含 HTTPS:${origins.join(', ')}`);
else bad('配置', `CLIENT_ORIGIN 仍是 ${origins.join(', ')} —— 生产必须改成真实 HTTPS 前端域名,否则 CORS 会拒绝真实前端`);

// ─────────────────────── 2. 存储与数据库 ───────────────────────
const provider = String(env.STORAGE_PROVIDER || 'json').toLowerCase();
if (provider === 'postgres') ok('存储', 'STORAGE_PROVIDER=postgres');
else bad('存储', `STORAGE_PROVIDER=${provider} —— 生产必须 postgres(JSON 是单用户开发态,没有账号边界)`);

const sslMode = String(env.DATABASE_SSL || '').toLowerCase();
if (['true', 'require', 'verify-full'].includes(sslMode)) ok('存储', `DATABASE_SSL=${sslMode}(严格校验证书)`);
else bad('存储', `DATABASE_SSL=${env.DATABASE_SSL || '(未设置)'} —— 生产要求 true/require/verify-full,启动时会直接拒绝`);
if (env.DATABASE_CA) {
  const caPath = path.resolve(env.DATABASE_CA);
  if (fs.existsSync(caPath)) ok('存储', `DATABASE_CA 可读:${path.basename(caPath)}`);
  else bad('存储', `DATABASE_CA 指向的文件不存在:${caPath}`);
}

let dbHost = null;
if (env.DATABASE_URL) {
  try {
    const parsed = new URL(env.DATABASE_URL);
    dbHost = parsed.hostname;
    if (['postgres:', 'postgresql:'].includes(parsed.protocol)) ok('存储', `DATABASE_URL 指向 ${parsed.hostname}/${parsed.pathname.slice(1)}(已脱敏)`);
    else bad('存储', `DATABASE_URL 协议不是 postgres:${parsed.protocol}`);
  } catch { bad('存储', 'DATABASE_URL 不是合法 URL'); }
} else if (provider === 'postgres') {
  bad('存储', 'STORAGE_PROVIDER=postgres 但没有 DATABASE_URL');
}

// ─────────────────────── 3. 模型 ───────────────────────
const modelProvider = String(env.MODEL_PROVIDER || 'mock').toLowerCase();
if (modelProvider === 'mock') bad('模型', 'MODEL_PROVIDER=mock —— 生产会用假模型回复(代码在生产会拒绝启动)');
else ok('模型', `MODEL_PROVIDER=${modelProvider}`);
if (modelProvider !== 'mock' && !env.MODEL_API_KEY && !env.MODEL_OPENAI_API_KEY) warn('模型', '未设置任何模型密钥(MODEL_API_KEY / MODEL_OPENAI_API_KEY)');

// ─────────────────────── 4. 运行时超时(本轮新增) ───────────────────────
const prepare = Number(env.CHAT_PREPARE_TIMEOUT_MS || 30_000);
const run = Number(env.CHAT_RUN_TIMEOUT_MS || 120_000);
const grace = Number(env.CHAT_TERMINATION_GRACE_MS || 5_000);
if (prepare < run) ok('运行时', `超时配置合理:准备 ${prepare}ms < 运行 ${run}ms,兜底 ${grace}ms`);
else bad('运行时', `CHAT_PREPARE_TIMEOUT_MS(${prepare}) 应小于 CHAT_RUN_TIMEOUT_MS(${run})`);
if ([...Object.values({ prepare, run, grace })].some(value => !Number.isFinite(value) || value <= 0)) {
  bad('运行时', 'CHAT_*_TIMEOUT 存在非正数或非数字');
}

// ─────────────────────── 5. 记忆模块 ───────────────────────
if (env.MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS === 'true') {
  if (isProd) bad('记忆', 'MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS=true 在生产是危险的(它只在非生产生效,但仍应从生产配置里移除)');
  else warn('记忆', 'MEMORY_ALLOW_UNTRUSTED_AGENT_HEADERS=true(仅非生产可生效,上线前记得关)');
}
const flags = ['AUTO_EXTRACT', 'AUTO_PROFILE_UPDATE', 'HYBRID_RETRIEVAL', 'VECTOR_RETRIEVAL', 'IMPORTANCE_RANKING', 'EPISODE_GROUPING', 'PROACTIVE_MENTION'];
const enabledFlags = flags.filter(name => String(env[`MEMORY_${name}`] || '').toLowerCase() === 'true');
if (enabledFlags.length) warn('记忆', `已开启的记忆功能开关:${enabledFlags.join(', ')} —— 确认是刻意开启并已验收`);
else ok('记忆', '记忆功能开关全部默认关闭');

// ─────────────────────── 6. 仓库卫生 ───────────────────────
if (listTracked('.env').includes('.env')) bad('仓库', '.env 被 git 跟踪了!必须移除并清理历史');
else ok('仓库', '.env 未被跟踪');
for (const dir of ['server/data', 'Knowledge_Base']) {
  const tracked = listTracked(`${dir}/`);
  if (tracked) bad('仓库', `${dir}/ 下有被跟踪的文件(本地备份/私有资料不应入库):${tracked.split('\n')[0]}…`);
  else ok('仓库', `${dir}/ 未入库`);
}
if (fs.existsSync(path.join(root, 'dist'))) warn('仓库', '存在构建产物 dist/(部署时生成即可,不要提交)');

const SECRET_PATTERNS = [
  ['JWT/Token 字面量', /eyJhbGciOi/],
  ['数据库连接串', /postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`]*@/],
  ['OpenAI 风格密钥', /sk-[A-Za-z0-9]{20,}/],
  ['service_role 密钥', /service_role/]
];
const scanDirs = ['server', 'client/src', 'scripts', 'docs'];
let secretHits = 0;
for (const dir of scanDirs) {
  const files = listTracked(`${dir}/`).split('\n').filter(Boolean);
  for (const file of files) {
    // 跳开本文件:它的 SECRET_PATTERNS 里就是这些正则字面量,扫自己会永远误报。
    if (file === 'scripts/preflight-check.mjs') continue;
    if (/\.(png|jpe?g|gif|webp|mp3|mp4|wav|woff2?|ttf|ico|pdf)$/i.test(file)) continue;
    const content = readFile(file);
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(content)) { secretHits += 1; bad('仓库', `疑似${label}:${file}`); }
    }
  }
}
if (!secretHits) ok('仓库', '已跟踪文件未发现密钥/连接串字面量');

for (const file of ['LICENSE', 'NOTICE', '.env.example']) {
  if (fs.existsSync(path.join(root, file))) ok('仓库', `${file} 存在`);
  else warn('仓库', `${file} 缺失`);
}

// 前端引用的公开资源是否真的在仓库里 —— 公开仓库最容易漏的就是这类:
// 代码引了 /xxx.mp4,但该文件被 .gitignore 排除,别人 clone 下来就是坏的。
const assetPattern = /["'`](\/[A-Za-z0-9_\-./]+\.(?:mp4|webm|png|jpe?g|gif|svg|webp|woff2?|mp3|wav|json|webmanifest))["'`]/g;
const assetRefs = new Set();
for (const file of listTracked('client/src/').split('\n').filter(Boolean)) {
  if (!/\.(m?js|jsx)$/.test(file)) continue;
  for (const match of readFile(file).matchAll(assetPattern)) assetRefs.add(match[1]);
}
const missingAssets = [];
const expectedMissing = [];
for (const ref of assetRefs) {
  // 先看是不是被 .gitignore 排除的:本地存在不代表仓库里有 ——
  // 公开后别人 clone 下来就是缺的,这类必须报出来(无论本地在不在)。
  let ignored = false;
  try { ignored = Boolean(execSync(`git check-ignore "client/public${ref}"`, { cwd: root }).toString().trim()); } catch { ignored = false; }
  if (ignored) { expectedMissing.push(ref); continue; }
  if (!fs.existsSync(path.join(root, 'client/public', ref))) missingAssets.push(ref);
}
if (missingAssets.length) bad('仓库', `前端引用了仓库里不存在的资源：${missingAssets.slice(0, 5).join(', ')}`);
if (expectedMissing.length) warn('仓库', `前端引用了被 .gitignore 排除的资源，公开仓库里会缺失：${expectedMissing.join(', ')} —— 要么补授权后入库，要么换可分发素材`);
if (!missingAssets.length && !expectedMissing.length) ok('仓库', `前端引用的 ${assetRefs.size} 个静态资源都存在且可分发`);

// ─────────────────────── 7. .env.example 覆盖率 ───────────────────────
// 防止将来新增环境变量却忘了写进示例(别人 clone 下来配不起来)。
// 已知的「举例用的占位名」不算真变量。
const PLACEHOLDER_ENV_NAMES = new Set(['X', 'YOUR_VAR', 'NAME', 'VARIABLE']);
const declared = new Set();
for (const line of readFile('.env.example').split('\n')) {
  const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
  if (match) declared.add(match[1]);
}
const used = new Set();
for (const dir of ['server', 'client/src', 'scripts']) {
  for (const file of listTracked(`${dir}/`).split('\n').filter(Boolean)) {
    if (!/\.(m?js|jsx)$/.test(file)) continue;
    const content = readFile(file);
    for (const match of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) used.add(match[1]);
    for (const match of content.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/g)) used.add(match[1]);
  }
}
// 由模板拼出来的名字扫描不到,显式补上
for (const name of flags) used.add(`MEMORY_${name}`);
// Vite 自带的内置 env(不是需要声明的配置)
const ignore = new Set(['NODE_ENV', 'NODE_OPTIONS', 'PROD', 'DEV', 'MODE', 'BASE_URL', 'SSR', ...PLACEHOLDER_ENV_NAMES]);
const missing = [...used].filter(name => !declared.has(name) && !ignore.has(name)).sort();
if (missing.length) bad('文档', `.env.example 缺少 ${missing.length} 个实际用到的变量:${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
else ok('文档', `.env.example 覆盖了全部 ${used.size} 个实际用到的变量`);

// ─────────────────────── 8. 数据库连通性 + 数据完整性 ───────────────────────
if (skipDb) {
  warn('数据', '已跳过数据库检查(--no-db)');
} else if (!env.DATABASE_URL) {
  warn('数据', '没有 DATABASE_URL,跳过数据库检查');
} else {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: env.DATABASE_URL, ssl: resolveDbSsl(), connectionTimeoutMillis: 10_000 });
  try {
    const started = Date.now();
    await client.connect();
    await client.query('SELECT 1');
    ok('数据', `数据库连接成功(${Date.now() - started}ms,host=${dbHost})`);

    const tables = ['cochpia_state', 'cochpia_user_states', 'cochpia_legacy_claim'];
    const found = [];
    for (const table of tables) {
      const result = await client.query('SELECT to_regclass($1) AS name', [table]);
      found.push([table, Boolean(result.rows[0]?.name)]);
    }
    const missingTables = found.filter(([, exists]) => !exists).map(([table]) => table);
    if (missingTables.length) warn('数据', `表尚不存在(首次启动会自动建):${missingTables.join(', ')}`);
    else ok('数据', '核心表齐备');

    const tenants = await client.query("SELECT DISTINCT state->'memoryModule'->'assertions'->0->>'tenantId' AS tenant FROM cochpia_user_states WHERE state ? 'memoryModule'");
    const tenantIds = tenants.rows.map(row => row.tenant).filter(Boolean);
    const configuredTenant = env.MEMORY_TENANT_ID || 'local-tenant';
    const mismatched = tenantIds.filter(tenant => tenant !== configuredTenant);
    if (mismatched.length) bad('数据', `库中记忆的 tenantId(${mismatched.join(', ')})与 MEMORY_TENANT_ID(${configuredTenant}) 不一致 —— 会导致记忆全部不可见`);
    else ok('数据', `tenantId 一致(${configuredTenant})`);

    const rows = (await client.query("SELECT user_id, state FROM cochpia_user_states WHERE state ? 'memoryModule'")).rows;
    let stale = 0;
    let total = 0;
    for (const row of rows) {
      const owner = String(row.user_id);
      for (const collection of ['assertions', 'rawEvents']) {
        for (const item of row.state.memoryModule?.[collection] || []) {
          total += 1;
          if (item?.userId && item.userId !== owner) stale += 1;
        }
      }
    }
    if (stale) bad('数据', `${stale}/${total} 条记忆/事件的归属与所属账号不一致 —— 这些数据对该用户不可见(见 scripts/migrate-legacy-ownership.mjs)`);
    else ok('数据', `记忆/事件归属全部正确(${total} 条)`);
  } catch (error) {
    bad('数据', `数据库检查失败:${error.code || error.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// ─────────────────────── 输出 ───────────────────────
const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' };
console.log(`\n上线前自检(${isProd ? 'production 模式' : `NODE_ENV=${env.NODE_ENV || '未设置'}`})\n`);
let area = null;
for (const item of results) {
  if (item.area !== area) { area = item.area; console.log(`\n【${area}】`); }
  console.log(`  ${icon[item.level]} ${item.message}`);
}
const counts = { ok: 0, warn: 0, bad: 0 };
for (const item of results) counts[item.level] += 1;
console.log(`\n合计:✅ ${counts.ok}  ⚠️ ${counts.warn}  ❌ ${counts.bad}`);
if (counts.bad) console.log('存在必须处理的项(❌),先解决再上线。');
else if (counts.warn) console.log('没有阻断项;⚠️ 请逐条确认是否有意为之。');
else console.log('全部通过。');
console.log('手动项(脚本无法验证):HTTPS/域名、定时备份与恢复演练、日志留存、目标环境的端到端验收。见 deploy/preflight.md\n');
process.exit(counts.bad ? 1 : 0);
