#!/usr/bin/env node
// 把单用户(local-user)时代的遗留记录,归属重新盖到真正的主人身上。
//
// 背景(实测):
//   迁移到按用户分表后,老数据仍带着 local-user 身份。而 Memory Module 的可见性判断是
//     canSee: assertion.userId === context.subjectUserId
//   于是这些记忆对登录用户**彻底不可见** —— 用户以为记忆还在,实际一条也召不回来。
//   实测:某用户 79 条记忆里 76 条是 local-user;BM25 能命中 12 条,线上 API 只回 1 条。
//
// 处置:
//   · 合法主人(cochpia_legacy_claim 登记的那一行)→ 身份字段改成该行 user_id
//   · 其他用户的行 → 里面的 legacy 记录是 emptyUserState 从 base state 克隆带进来的**别人的数据**,
//     应当删除(原件仍在 base state 与主人的行里)
//
// 注意身份不止一个字段名:实测还有 subjectUserId / subjectId / actorId / requestedBy,
// 以及以 `tenant:legacyId` 为键的 redactionEpochs。所以这里做**通用遍历**,不按集合白名单,
// 免得将来多一个集合又漏掉。
//
// 默认 dry-run;--apply 才写回。
// ⚠️ 必须停掉服务后再执行:内存里有 userStateCache,运行中的实例会把改动冲掉。
//
//   node scripts/migrate-legacy-ownership.mjs           # 预览
//   node scripts/migrate-legacy-ownership.mjs --apply   # 写回
import 'dotenv/config';
import { Pool } from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';

const APPLY = process.argv.includes('--apply');
// 删除别人遗留记录是更重的动作(需要先确认那些真是外来数据),默认不做。
const DROP_FOREIGN = process.argv.includes('--drop-foreign');
const LEGACY_IDS = new Set(['local-user', '00000000-0000-0000-0000-000000000001', '', null, undefined]);
// 重盖归属时:空归属也算「没主的」,在主人自己的行里那就是他的。
const isLegacy = value => LEGACY_IDS.has(value);
// 删除时:**只认显式打了 legacy 标记的**。
// 曾经把 undefined 也当外来,差点删掉用户自建的角色(它们的 ownerId 本来就是空的)。
const LEGACY_STAMPS = new Set(['local-user', '00000000-0000-0000-0000-000000000001']);
const isLegacyStamped = value => LEGACY_STAMPS.has(value);
// 代表「这条记录属于谁」的字段名。
const IDENTITY_FIELDS = ['userId', 'ownerId', 'subjectUserId', 'subjectId', 'actorId', 'requestedBy'];
// 以 `<tenant>:<subjectUserId>` 为键的对象,键里也带着旧身份。
const IDENTITY_KEYED_OBJECTS = ['redactionEpochs'];

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL 未配置。'); process.exit(1); }

const isLegacyRecord = value => value && typeof value === 'object' && !Array.isArray(value)
  && IDENTITY_FIELDS.some(field => isLegacyStamped(value[field]));

function migrate(node, ctx) {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      const kept = [];
      for (const item of value) {
        if (item && typeof item === 'object') {
          if (ctx.dropForeign && isLegacyRecord(item)) { ctx.dropped.push(key); continue; }
          migrate(item, ctx);
        }
        kept.push(item);
      }
      if (kept.length !== value.length) node[key] = kept;
      continue;
    }
    if (value && typeof value === 'object') {
      if (IDENTITY_KEYED_OBJECTS.includes(key)) {
        for (const objectKey of Object.keys(value)) {
          const [tenant, subject] = objectKey.split(':');
          if (!isLegacyStamped(subject)) continue;
          const nextKey = `${tenant}:${ctx.owner}`;
          if (ctx.dropForeign) {
            delete value[objectKey];
            ctx.dropped.push(`${key}(${objectKey})`);
          } else {
            value[nextKey] = Math.max(Number(value[nextKey] || 0), Number(value[objectKey] || 0));
            delete value[objectKey];
            ctx.keyRenamed.push(`${key}`);
          }
        }
      }
      migrate(value, ctx);
      continue;
    }
    if (IDENTITY_FIELDS.includes(key) && isLegacy(value)) {
      if (!ctx.dropForeign) { node[key] = ctx.owner; ctx.identity.push(key); }
    }
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDbSsl(), max: 2, connectionTimeoutMillis: 10_000 });
const rows = (await pool.query('SELECT user_id, state FROM cochpia_user_states')).rows;
const claim = (await pool.query('SELECT user_id FROM cochpia_legacy_claim WHERE id = 1')).rows[0]?.user_id || null;

console.log(`模式: ${APPLY ? '写回(--apply)' : '预览(dry-run)'}${DROP_FOREIGN ? ' + 删除外来记录(--drop-foreign)' : ' [仅改归属]'}`);
console.log(`合法主人(legacy claim): ${claim || '(未登记)'}`);
console.log(`待检查行: ${rows.length}`);
if (!DROP_FOREIGN) console.log('提示: 其他用户行里的外来记录本次不动(需要时加 --drop-foreign)。');
console.log('');

const tally = {};
let changedRows = 0;

for (const row of rows) {
  const owner = String(row.user_id);
  const isOwner = Boolean(claim) && owner === claim;
  // 非主人行默认完全不动:把别人的记录改成他们的名字同样是错的。
  const dropForeign = DROP_FOREIGN && !isOwner;
  if (!isOwner && !dropForeign) { console.log(`  其他用户 ${owner.slice(0, 8)}…  （本次不动）`); continue; }
  const ctx = { owner, isOwner, dropForeign, identity: [], dropped: [], keyRenamed: [] };
  migrate(row.state || {}, ctx);

  const fieldCounts = {};
  for (const field of ctx.identity) fieldCounts[field] = (fieldCounts[field] || 0) + 1;
  for (const field of Object.keys(fieldCounts)) tally[field] = (tally[field] || 0) + fieldCounts[field];
  tally['redactionEpochs(键改名)'] = (tally['redactionEpochs(键改名)'] || 0) + ctx.keyRenamed.length;
  for (const name of ctx.dropped) tally[`删除:${name}`] = (tally[`删除:${name}`] || 0) + 1;

  const touched = ctx.identity.length + ctx.keyRenamed.length + ctx.dropped.length;
  console.log(`${isOwner ? '★ 合法主人' : '  其他用户(清理外来)'} ${owner.slice(0, 8)}…`);
  if (!touched) { console.log('   （无需处理）'); continue; }
  for (const [field, count] of Object.entries(fieldCounts)) console.log(`   改归属 → 本人  ${field.padEnd(26)} ${count}`);

  if (ctx.keyRenamed.length) console.log(`   改归属 → 本人  ${'redactionEpochs(键)'.padEnd(26)} ${ctx.keyRenamed.length}`);
  for (const [name, count] of Object.entries(ctx.dropped.reduce((acc, key) => ({ ...acc, [key]: (acc[key] || 0) + 1 }), {}))) {
    console.log(`   删除(别人的)   ${name.padEnd(26)} ${count}`);
  }

  if (APPLY) {
    await pool.query('UPDATE cochpia_user_states SET state = $2::jsonb, updated_at = now() WHERE user_id = $1', [owner, JSON.stringify(row.state)]);
    changedRows += 1;
    console.log('   ✅ 已写回');
  }
}

console.log('\n合计:');
for (const [name, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${name}`);
if (APPLY) console.log(`已写回 ${changedRows} 行`);
else console.log('\n确认无误后加 --apply 写回(请先停掉服务)。');
await pool.end();
