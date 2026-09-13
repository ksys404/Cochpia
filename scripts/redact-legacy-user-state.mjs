#!/usr/bin/env node
// 清理 + 脱敏:单用户时代遗留的「模板状态」及其派生污染。
//
// 两个问题:
//   1) 其他用户的行里 profile 是从 base state 原样克隆来的 —— 他们看到的是**上一位用户的**
//      名字/年龄/立绘(实测:某账号的 profile 连 updatedAt 都与 base 逐字节相同)。
//   2) base state 本身(cochpia_state)仍存着 legacy 用户的全部内容(79 条记忆、立绘 base64、
//      257 条原始事件)。代码已修成 fail-closed,不该再有任何新用户继承它;但这份数据本身就是
//      一颗地雷 —— 万一将来有人改回克隆式初始化,泄漏立刻复现。所以**脱敏**掉。
//
// 判定用「逐字节相同」而不是「看起来像继承」:只有与 base 完全一致的 profile 才会被重置,
// 用户自己改过的画像不动。
//
// 默认 dry-run;--apply 才写回。必须先停服务(userStateCache)。
//
//   node scripts/redact-legacy-user-state.mjs           # 预览
//   node scripts/redact-legacy-user-state.mjs --apply   # 写回
import 'dotenv/config';
import { Pool } from 'pg';
import { resolveDbSsl } from '../server/db-ssl.js';
import { emptyUserState } from '../server/store.js';

const APPLY = process.argv.includes('--apply');
const EMPTY_PROFILE = { name: '', gender: 'none', age: null, avatar: '✦' };

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL 未配置。'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveDbSsl(), max: 2, connectionTimeoutMillis: 10_000 });
const baseRow = (await pool.query('SELECT state FROM cochpia_state WHERE id = 1')).rows[0]?.state || null;
const claim = (await pool.query('SELECT user_id FROM cochpia_legacy_claim WHERE id = 1')).rows[0]?.user_id || null;
const rows = (await pool.query('SELECT user_id, state FROM cochpia_user_states')).rows;

console.log(`模式: ${APPLY ? '写回(--apply)' : '预览(dry-run)'}`);
console.log(`合法主人: ${claim || '(未登记)'}   用户行: ${rows.length}`);
console.log(`base state(cochpia_state): ${baseRow ? '存在' : '不存在'}\n`);

const baseProfileJson = JSON.stringify(baseRow?.profile || null);
const writes = [];

for (const row of rows) {
  const owner = String(row.user_id);
  const state = row.state || {};
  if (owner === claim) { console.log(`★ 合法主人 ${owner.slice(0, 8)}…  （自己的数据,不动）`); continue; }

  const profileJson = JSON.stringify(state.profile || null);
  const identicalToBase = baseProfileJson !== 'null' && profileJson === baseProfileJson;
  const hasImagePayload = Boolean(state.profile?.avatarImage || state.profile?.characterSheet);
  if (!identicalToBase) {
    console.log(`  其他用户 ${owner.slice(0, 8)}…  profile 已被自己改过,不动 ${hasImagePayload ? '(仍带图片载荷)' : ''}`);
    continue;
  }

  const before = { name: state.profile?.name, age: state.profile?.age, images: [state.profile?.avatarImage, state.profile?.characterSheet].filter(Boolean).length };
  state.profile = { ...EMPTY_PROFILE };
  writes.push({ table: 'cochpia_user_states', key: owner, state });
  console.log(`  其他用户 ${owner.slice(0, 8)}…  profile 与 base 逐字节相同 → 重置(脱掉别人的画像)`);
  console.log(`      ${JSON.stringify(before)} → ${JSON.stringify(EMPTY_PROFILE)}`);
}

// base state 脱敏:内容搬去主人的行,这里只留空状态 + 明确标记。
if (baseRow) {
  const assertions = baseRow.memoryModule?.assertions?.length || 0;
  const rawEvents = baseRow.memoryModule?.rawEvents?.length || 0;
  const hasImages = Boolean(baseRow.profile?.avatarImage || baseRow.profile?.characterSheet);
  console.log(`\nbase state 脱敏: 记忆 ${assertions} 条 / 原始事件 ${rawEvents} 条 / 立绘 ${hasImages ? '有' : '无'} → 全部替换为规范空状态`);
  if (assertions || rawEvents || hasImages) {
    writes.push({
      table: 'cochpia_state',
      key: '1',
      state: {
        ...emptyUserState({}),
        legacyStateRedactedAt: new Date().toISOString(),
        legacyStateRedactionNote: 'single-user-era state: user content now lives in the claiming account row'
      }
    });
  }
}

console.log(`\n待写回 ${writes.length} 处`);
if (APPLY) {
  for (const write of writes) {
    if (write.table === 'cochpia_state') await pool.query('UPDATE cochpia_state SET state = $1::jsonb, updated_at = now() WHERE id = 1', [JSON.stringify(write.state)]);
    else await pool.query('UPDATE cochpia_user_states SET state = $1::jsonb, updated_at = now() WHERE user_id = $2', [JSON.stringify(write.state), write.key]);
    console.log(`  ✅ ${write.table} ${String(write.key).slice(0, 8)}`);
  }
} else if (writes.length) {
  console.log('确认无误后加 --apply 写回(请先停掉服务)。');
}
await pool.end();
